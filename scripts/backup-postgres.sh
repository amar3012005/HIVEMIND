#!/bin/bash
# HIVE-MIND PostgreSQL Backup Script
# EU Sovereign Deployment - GDPR, NIS2, DORA Compliant
# Features: Daily/Weekly/Monthly retention, AES-256-CBC encryption, S3 upload

set -euo pipefail

# ==========================================
# CONFIGURATION
# ==========================================

# Database configuration
DB_HOST="${POSTGRES_HOST:-postgres}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_NAME="${POSTGRES_DB:-hivemind}"
DB_USER="${POSTGRES_USER:-hivemind}"
DB_PASSWORD="${POSTGRES_PASSWORD}"

# Backup configuration
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_RETENTION_WEEKS="${BACKUP_RETENTION_WEEKS:-4}"
BACKUP_RETENTION_MONTHS="${BACKUP_RETENTION_MONTHS:-12}"

# Encryption configuration (AES-256-CBC)
ENCRYPTION_ENABLED="${ENCRYPTION_ENABLED:-true}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

# S3 configuration (Scaleway compatible)
S3_ENABLED="${S3_ENABLED:-false}"
S3_BUCKET="${S3_BUCKET:-hivemind-backups}"
S3_ENDPOINT="${S3_ENDPOINT:-s3.fr-par.scw.cloud}"
S3_REGION="${S3_REGION:-fr-par}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${S3_SECRET_KEY:-}"

# Logging
LOG_FILE="${LOG_FILE:-/var/log/hivemind/backup.log}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"

# ==========================================
# FUNCTIONS
# ==========================================

log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo "[${timestamp}] [${level}] ${message}" | tee -a "${LOG_FILE}"
}

log_info() { log "INFO" "$@"; }
log_warn() { log "WARN" "$@"; }
log_error() { log "ERROR" "$@"; }

check_requirements() {
    log_info "Checking requirements..."
    
    local missing=()
    
    # Check for required commands
    for cmd in pg_dump gzip openssl; do
        if ! command -v "$cmd" &> /dev/null; then
            missing+=("$cmd")
        fi
    done
    
    # Check for AWS CLI if S3 is enabled
    if [[ "${S3_ENABLED}" == "true" ]] && ! command -v aws &> /dev/null; then
        missing+=("aws")
    fi
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required commands: ${missing[*]}"
        exit 1
    fi
    
    # Check for encryption key if encryption is enabled
    if [[ "${ENCRYPTION_ENABLED}" == "true" ]] && [[ -z "${ENCRYPTION_KEY}" ]]; then
        log_error "Encryption enabled but ENCRYPTION_KEY not set"
        exit 1
    fi
    
    log_info "All requirements satisfied"
}

create_backup_dir() {
    log_info "Creating backup directory structure..."
    
    mkdir -p "${BACKUP_DIR}/daily"
    mkdir -p "${BACKUP_DIR}/weekly"
    mkdir -p "${BACKUP_DIR}/monthly"
    mkdir -p "${BACKUP_DIR}/temp"
    
    log_info "Backup directories created"
}

get_backup_filename() {
    local backup_type="$1"
    local timestamp
    timestamp=$(date -u +"%Y%m%d_%H%M%S")
    echo "hivemind_${DB_NAME}_${backup_type}_${timestamp}.sql.gz.enc"
}

perform_backup() {
    local backup_type="$1"
    local filename
    filename=$(get_backup_filename "${backup_type}")
    local temp_file="${BACKUP_DIR}/temp/${filename%.enc}"
    local final_file="${BACKUP_DIR}/${backup_type}/${filename}"
    
    log_info "Starting ${backup_type} backup: ${filename}"
    
    # Perform pg_dump
    log_info "Dumping database ${DB_NAME} from ${DB_HOST}:${DB_PORT}..."
    PGPASSWORD="${DB_PASSWORD}" pg_dump \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --format=plain \
        --no-owner \
        --no-privileges \
        --verbose \
        2>> "${LOG_FILE}" | gzip > "${temp_file}"
    
    local dump_exit_code=$?
    if [[ ${dump_exit_code} -ne 0 ]]; then
        log_error "pg_dump failed with exit code ${dump_exit_code}"
        rm -f "${temp_file}"
        exit 1
    fi
    
    local dump_size
    dump_size=$(stat -c%s "${temp_file}" 2>/dev/null || stat -f%z "${temp_file}" 2>/dev/null || echo "unknown")
    log_info "Database dump completed: ${dump_size} bytes"
    
    # Encrypt backup if enabled
    if [[ "${ENCRYPTION_ENABLED}" == "true" ]]; then
        log_info "Encrypting backup with AES-256-CBC..."
        openssl enc -aes-256-cbc \
            -salt \
            -pbkdf2 \
            -iter 100000 \
            -in "${temp_file}" \
            -out "${final_file}" \
            -pass pass:"${ENCRYPTION_KEY}"
        
        local encrypt_exit_code=$?
        rm -f "${temp_file}"
        
        if [[ ${encrypt_exit_code} -ne 0 ]]; then
            log_error "Encryption failed with exit code ${encrypt_exit_code}"
            exit 1
        fi
        
        log_info "Backup encrypted successfully"
    else
        mv "${temp_file}" "${final_file}"
    fi
    
    # Generate checksum
    log_info "Generating SHA-256 checksum..."
    local checksum_file="${final_file}.sha256"
    sha256sum "${final_file}" > "${checksum_file}"
    
    log_info "Backup completed: ${final_file}"
    echo "${final_file}"
}

upload_to_s3() {
    local backup_file="$1"
    local backup_type
    backup_type=$(basename "$(dirname "${backup_file}")")
    local filename
    filename=$(basename "${backup_file}")
    
    if [[ "${S3_ENABLED}" != "true" ]]; then
        log_info "S3 upload disabled, skipping..."
        return 0
    fi
    
    log_info "Uploading backup to S3: ${S3_BUCKET}/${backup_type}/${filename}"
    
    # Configure AWS CLI for S3-compatible storage
    export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}"
    export AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"
    export AWS_DEFAULT_REGION="${S3_REGION}"
    
    aws s3 cp "${backup_file}" "s3://${S3_BUCKET}/${backup_type}/${filename}" \
        --endpoint-url "https://${S3_ENDPOINT}" \
        --storage-class STANDARD \
        --quiet
    
    local upload_exit_code=$?
    if [[ ${upload_exit_code} -ne 0 ]]; then
        log_error "S3 upload failed with exit code ${upload_exit_code}"
        return 1
    fi
    
    # Upload checksum file
    local checksum_file="${backup_file}.sha256"
    if [[ -f "${checksum_file}" ]]; then
        aws s3 cp "${checksum_file}" "s3://${S3_BUCKET}/${backup_type}/${filename}.sha256" \
            --endpoint-url "https://${S3_ENDPOINT}" \
            --quiet
    fi
    
    log_info "Backup uploaded to S3 successfully"
    return 0
}

cleanup_old_backups() {
    log_info "Cleaning up old backups..."
    
    # Daily backups - keep last N days
    log_info "Removing daily backups older than ${BACKUP_RETENTION_DAYS} days..."
    find "${BACKUP_DIR}/daily" -type f -name "*.sql.gz*" -mtime +${BACKUP_RETENTION_DAYS} -delete 2>/dev/null || true
    find "${BACKUP_DIR}/daily" -type f -name "*.sha256" -mtime +${BACKUP_RETENTION_DAYS} -delete 2>/dev/null || true
    
    # Weekly backups - keep last N weeks
    local weeks_days=$((BACKUP_RETENTION_WEEKS * 7))
    log_info "Removing weekly backups older than ${BACKUP_RETENTION_WEEKS} weeks..."
    find "${BACKUP_DIR}/weekly" -type f -name "*.sql.gz*" -mtime +${weeks_days} -delete 2>/dev/null || true
    find "${BACKUP_DIR}/weekly" -type f -name "*.sha256" -mtime +${weeks_days} -delete 2>/dev/null || true
    
    # Monthly backups - keep last N months
    local months_days=$((BACKUP_RETENTION_MONTHS * 30))
    log_info "Removing monthly backups older than ${BACKUP_RETENTION_MONTHS} months..."
    find "${BACKUP_DIR}/monthly" -type f -name "*.sql.gz*" -mtime +${months_days} -delete 2>/dev/null || true
    find "${BACKUP_DIR}/monthly" -type f -name "*.sha256" -mtime +${months_days} -delete 2>/dev/null || true
    
    # Clean temp directory
    log_info "Cleaning temp directory..."
    find "${BACKUP_DIR}/temp" -type f -mmin +60 -delete 2>/dev/null || true
    
    log_info "Cleanup completed"
}

rotate_weekly_backup() {
    local day_of_week
    day_of_week=$(date +%u)
    
    if [[ "${day_of_week}" -eq 7 ]]; then
        log_info "Sunday - creating weekly backup..."
        local backup_file
        backup_file=$(perform_backup "weekly")
        upload_to_s3 "${backup_file}"
    fi
}

rotate_monthly_backup() {
    local day_of_month
    day_of_month=$(date +%d)
    
    if [[ "${day_of_month}" -eq "01" ]]; then
        log_info "First of month - creating monthly backup..."
        local backup_file
        backup_file=$(perform_backup "monthly")
        upload_to_s3 "${backup_file}"
    fi
}

verify_backup() {
    local backup_file="$1"
    
    log_info "Verifying backup integrity..."
    
    # Check file exists
    if [[ ! -f "${backup_file}" ]]; then
        log_error "Backup file not found: ${backup_file}"
        return 1
    fi
    
    # Verify checksum
    local checksum_file="${backup_file}.sha256"
    if [[ -f "${checksum_file}" ]]; then
        log_info "Verifying SHA-256 checksum..."
        if sha256sum -c "${checksum_file}" --quiet; then
            log_info "Checksum verification passed"
        else
            log_error "Checksum verification failed!"
            return 1
        fi
    else
        log_warn "Checksum file not found, skipping verification"
    fi
    
    # Test decryption (if encrypted)
    if [[ "${ENCRYPTION_ENABLED}" == "true" ]] && [[ "${backup_file}" == *.enc ]]; then
        log_info "Testing decryption..."
        if openssl enc -aes-256-cbc -d \
            -pbkdf2 \
            -iter 100000 \
            -in "${backup_file}" \
            -pass pass:"${ENCRYPTION_KEY}" \
            | gzip -t 2>/dev/null; then
            log_info "Decryption test passed"
        else
            log_error "Decryption test failed!"
            return 1
        fi
    fi
    
    log_info "Backup verification completed successfully"
    return 0
}

send_notification() {
    local status="$1"
    local message="$2"
    
    # Slack webhook (optional)
    if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
        local color
        if [[ "${status}" == "success" ]]; then
            color="good"
        else
            color="danger"
        fi
        
        curl -s -X POST "${SLACK_WEBHOOK_URL}" \
            -H 'Content-Type: application/json' \
            -d "{
                \"attachments\": [{
                    \"color\": \"${color}\",
                    \"title\": \"HIVE-MIND Backup ${status}\",
                    \"text\": \"${message}\",
                    \"fields\": [
                        {\"title\": \"Database\", \"value\": \"${DB_NAME}\", \"short\": true},
                        {\"title\": \"Host\", \"value\": \"${DB_HOST}\", \"short\": true},
                        {\"title\": \"Time\", \"value\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"short\": true}
                    ]
                }]
            }" || true
    fi
    
    # Email notification (optional)
    if [[ -n "${NOTIFICATION_EMAIL:-}" ]] && command -v mail &> /dev/null; then
        echo "${message}" | mail -s "HIVE-MIND Backup ${status}" "${NOTIFICATION_EMAIL}" || true
    fi
}

# ==========================================
# MAIN
# ==========================================

main() {
    local start_time
    start_time=$(date +%s)
    
    log_info "=========================================="
    log_info "HIVE-MIND PostgreSQL Backup Started"
    log_info "=========================================="
    
    # Check requirements
    check_requirements
    
    # Create backup directory structure
    create_backup_dir
    
    # Perform daily backup
    local backup_file
    backup_file=$(perform_backup "daily")
    
    # Verify backup
    if ! verify_backup "${backup_file}"; then
        log_error "Backup verification failed!"
        send_notification "failure" "Backup verification failed for ${backup_file}"
        exit 1
    fi
    
    # Upload to S3
    upload_to_s3 "${backup_file}"
    
    # Rotate weekly backup (if Sunday)
    rotate_weekly_backup
    
    # Rotate monthly backup (if 1st of month)
    rotate_monthly_backup
    
    # Cleanup old backups
    cleanup_old_backups
    
    # Calculate duration
    local end_time
    end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    log_info "=========================================="
    log_info "HIVE-MIND PostgreSQL Backup Completed"
    log_info "Duration: ${duration} seconds"
    log_info "Backup file: ${backup_file}"
    log_info "=========================================="
    
    send_notification "success" "Backup completed successfully: ${backup_file}"
    
    return 0
}

# Run main function
main "$@"
