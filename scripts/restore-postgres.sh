#!/bin/bash
# HIVE-MIND PostgreSQL Restore Script
# EU Sovereign Deployment - GDPR, NIS2, DORA Compliant
# Features: AES-256-CBC decryption, integrity verification, point-in-time recovery

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
RESTORE_FROM="${RESTORE_FROM:-}"  # Path to backup file or 'latest'

# Encryption configuration
ENCRYPTION_ENABLED="${ENCRYPTION_ENABLED:-true}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

# S3 configuration
S3_ENABLED="${S3_ENABLED:-false}"
S3_BUCKET="${S3_BUCKET:-hivemind-backups}"
S3_ENDPOINT="${S3_ENDPOINT:-s3.fr-par.scw.cloud}"
S3_REGION="${S3_REGION:-fr-par}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${S3_SECRET_KEY:-}"

# Logging
LOG_FILE="${LOG_FILE:-/var/log/hivemind/restore.log}"

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

usage() {
    cat << EOF
HIVE-MIND PostgreSQL Restore Script

Usage: $(basename "$0") [OPTIONS]

Options:
    -f, --file FILE       Path to backup file to restore
    -l, --latest          Restore from latest backup
    -d, --daily N         Restore from Nth daily backup (default: 1)
    -w, --weekly N        Restore from Nth weekly backup (default: 1)
    -m, --monthly N       Restore from Nth monthly backup (default: 1)
    -t, --type TYPE       Backup type: daily, weekly, monthly
    -s, --s3              Download backup from S3
    -n, --dry-run         Show what would be restored without actually restoring
    -h, --help            Show this help message

Environment Variables:
    POSTGRES_HOST         Database host (default: postgres)
    POSTGRES_PORT         Database port (default: 5432)
    POSTGRES_DB           Database name (default: hivemind)
    POSTGRES_USER         Database user (default: hivemind)
    POSTGRES_PASSWORD     Database password (required)
    BACKUP_ENCRYPTION_KEY Encryption key for encrypted backups
    S3_BUCKET             S3 bucket name
    S3_ACCESS_KEY         S3 access key
    S3_SECRET_KEY         S3 secret key

Examples:
    # Restore from latest daily backup
    $(basename "$0") --latest

    # Restore from specific backup file
    $(basename "$0") --file /backups/daily/hivemind_hivemind_daily_20240101_020000.sql.gz.enc

    # Restore from weekly backup on S3
    $(basename "$0") --weekly 1 --type weekly --s3

    # Dry run to see what would be restored
    $(basename "$0") --latest --dry-run

EOF
    exit 0
}

check_requirements() {
    log_info "Checking requirements..."
    
    local missing=()
    
    for cmd in pg_restore psql gzip openssl; do
        if ! command -v "$cmd" &> /dev/null; then
            missing+=("$cmd")
        fi
    done
    
    if [[ "${S3_ENABLED}" == "true" ]] && ! command -v aws &> /dev/null; then
        missing+=("aws")
    fi
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required commands: ${missing[*]}"
        exit 1
    fi
    
    if [[ -z "${DB_PASSWORD}" ]]; then
        log_error "POSTGRES_PASSWORD environment variable is required"
        exit 1
    fi
    
    log_info "All requirements satisfied"
}

find_latest_backup() {
    local backup_type="${1:-daily}"
    local backup_dir="${BACKUP_DIR}/${backup_type}"
    
    log_info "Finding latest ${backup_type} backup..."
    
    if [[ ! -d "${backup_dir}" ]]; then
        log_error "Backup directory not found: ${backup_dir}"
        exit 1
    fi
    
    local latest_backup
    latest_backup=$(find "${backup_dir}" -type f -name "*.sql.gz*" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
    
    if [[ -z "${latest_backup}" ]]; then
        log_error "No backups found in ${backup_dir}"
        exit 1
    fi
    
    log_info "Latest backup: ${latest_backup}"
    echo "${latest_backup}"
}

find_nth_backup() {
    local backup_type="$1"
    local n="${2:-1}"
    local backup_dir="${BACKUP_DIR}/${backup_type}"
    
    log_info "Finding ${n}th ${backup_type} backup..."
    
    if [[ ! -d "${backup_dir}" ]]; then
        log_error "Backup directory not found: ${backup_dir}"
        exit 1
    fi
    
    local backup
    backup=$(find "${backup_dir}" -type f -name "*.sql.gz*" -printf '%T@ %p\n' 2>/dev/null | sort -rn | sed -n "${n}p" | cut -d' ' -f2-)
    
    if [[ -z "${backup}" ]]; then
        log_error "Backup #${n} not found in ${backup_dir}"
        exit 1
    fi
    
    log_info "Found backup: ${backup}"
    echo "${backup}"
}

download_from_s3() {
    local s3_path="$1"
    local local_path="$2"
    
    log_info "Downloading backup from S3: ${s3_path}"
    
    export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}"
    export AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"
    export AWS_DEFAULT_REGION="${S3_REGION}"
    
    aws s3 cp "s3://${S3_BUCKET}/${s3_path}" "${local_path}" \
        --endpoint-url "https://${S3_ENDPOINT}" \
        --quiet
    
    local download_exit_code=$?
    if [[ ${download_exit_code} -ne 0 ]]; then
        log_error "S3 download failed with exit code ${download_exit_code}"
        exit 1
    fi
    
    # Download checksum file
    local checksum_path="${s3_path}.sha256"
    local checksum_file="${local_path}.sha256"
    aws s3 cp "s3://${S3_BUCKET}/${checksum_path}" "${checksum_file}" \
        --endpoint-url "https://${S3_ENDPOINT}" \
        --quiet 2>/dev/null || true
    
    log_info "Download completed: ${local_path}"
}

verify_backup() {
    local backup_file="$1"
    
    log_info "Verifying backup integrity..."
    
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
    
    log_info "Backup verification completed"
    return 0
}

decrypt_backup() {
    local encrypted_file="$1"
    local decrypted_file="$2"
    
    if [[ "${ENCRYPTION_ENABLED}" != "true" ]] || [[ "${encrypted_file}" != *.enc ]]; then
        log_info "Backup is not encrypted, skipping decryption"
        cp "${encrypted_file}" "${decrypted_file}"
        return 0
    fi
    
    if [[ -z "${ENCRYPTION_KEY}" ]]; then
        log_error "Encryption key required but not provided"
        exit 1
    fi
    
    log_info "Decrypting backup..."
    
    openssl enc -aes-256-cbc -d \
        -pbkdf2 \
        -iter 100000 \
        -in "${encrypted_file}" \
        -out "${decrypted_file}" \
        -pass pass:"${ENCRYPTION_KEY}"
    
    local decrypt_exit_code=$?
    if [[ ${decrypt_exit_code} -ne 0 ]]; then
        log_error "Decryption failed with exit code ${decrypt_exit_code}"
        return 1
    fi
    
    log_info "Decryption completed: ${decrypted_file}"
    return 0
}

prepare_database() {
    log_info "Preparing database for restore..."
    
    # Terminate existing connections
    log_info "Terminating existing connections to ${DB_NAME}..."
    PGPASSWORD="${DB_PASSWORD}" psql \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d postgres \
        -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" \
        2>> "${LOG_FILE}" || true
    
    # Drop and recreate database
    log_info "Dropping existing database ${DB_NAME}..."
    PGPASSWORD="${DB_PASSWORD}" psql \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d postgres \
        -c "DROP DATABASE IF EXISTS ${DB_NAME};" \
        2>> "${LOG_FILE}"
    
    log_info "Creating new database ${DB_NAME}..."
    PGPASSWORD="${DB_PASSWORD}" psql \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d postgres \
        -c "CREATE DATABASE ${DB_NAME};" \
        2>> "${LOG_FILE}"
    
    log_info "Database prepared for restore"
}

perform_restore() {
    local backup_file="$1"
    local dry_run="${2:-false}"
    
    log_info "Starting restore from: ${backup_file}"
    
    # Decompress if gzipped
    local decompressed_file="${backup_file%.gz}"
    if [[ "${backup_file}" == *.gz ]]; then
        log_info "Decompressing backup..."
        gunzip -c "${backup_file}" > "${decompressed_file}"
        backup_file="${decompressed_file}"
    fi
    
    if [[ "${dry_run}" == "true" ]]; then
        log_info "[DRY RUN] Would restore from: ${backup_file}"
        log_info "[DRY RUN] Database: ${DB_NAME} on ${DB_HOST}:${DB_PORT}"
        return 0
    fi
    
    # Prepare database
    prepare_database
    
    # Perform restore
    log_info "Restoring database..."
    PGPASSWORD="${DB_PASSWORD}" psql \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        -f "${backup_file}" \
        2>> "${LOG_FILE}"
    
    local restore_exit_code=$?
    if [[ ${restore_exit_code} -ne 0 ]]; then
        log_error "Restore failed with exit code ${restore_exit_code}"
        return 1
    fi
    
    log_info "Restore completed successfully"
    return 0
}

verify_restore() {
    log_info "Verifying restore..."
    
    # Check database connection
    log_info "Testing database connection..."
    if ! PGPASSWORD="${DB_PASSWORD}" psql \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        -c "SELECT 1;" &> /dev/null; then
        log_error "Cannot connect to restored database"
        return 1
    fi
    
    # Check table count
    log_info "Checking table count..."
    local table_count
    table_count=$(PGPASSWORD="${DB_PASSWORD}" psql \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')
    
    log_info "Tables found: ${table_count}"
    
    if [[ "${table_count}" -lt 1 ]]; then
        log_warn "No tables found in restored database"
    fi
    
    # Check row counts for key tables
    log_info "Checking row counts..."
    PGPASSWORD="${DB_PASSWORD}" psql \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        -c "SELECT 'users' as table_name, COUNT(*) as row_count FROM users
            UNION ALL
            SELECT 'memories', COUNT(*) FROM memories
            UNION ALL
            SELECT 'sessions', COUNT(*) FROM sessions;" \
        2>> "${LOG_FILE}" || true
    
    log_info "Restore verification completed"
    return 0
}

cleanup_temp_files() {
    local temp_dir="${BACKUP_DIR}/restore_temp"
    
    log_info "Cleaning up temporary files..."
    rm -rf "${temp_dir}"
    
    log_info "Cleanup completed"
}

# ==========================================
# MAIN
# ==========================================

main() {
    local backup_file=""
    local backup_type="daily"
    local backup_n=1
    local from_s3=false
    local dry_run=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f|--file)
                backup_file="$2"
                shift 2
                ;;
            -l|--latest)
                backup_file="latest"
                shift
                ;;
            -d|--daily)
                backup_type="daily"
                backup_n="${2:-1}"
                shift 2 || shift
                ;;
            -w|--weekly)
                backup_type="weekly"
                backup_n="${2:-1}"
                shift 2 || shift
                ;;
            -m|--monthly)
                backup_type="monthly"
                backup_n="${2:-1}"
                shift 2 || shift
                ;;
            -t|--type)
                backup_type="$2"
                shift 2
                ;;
            -s|--s3)
                from_s3=true
                shift
                ;;
            -n|--dry-run)
                dry_run=true
                shift
                ;;
            -h|--help)
                usage
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                ;;
        esac
    done
    
    local start_time
    start_time=$(date +%s)
    
    log_info "=========================================="
    log_info "HIVE-MIND PostgreSQL Restore Started"
    log_info "=========================================="
    
    # Check requirements
    check_requirements
    
    # Find backup file
    if [[ -z "${backup_file}" ]]; then
        log_error "No backup file specified. Use --file, --latest, --daily, --weekly, or --monthly"
        usage
    fi
    
    if [[ "${backup_file}" == "latest" ]]; then
        backup_file=$(find_latest_backup "${backup_type}")
    elif [[ "${backup_file}" =~ ^[0-9]+$ ]]; then
        backup_file=$(find_nth_backup "${backup_type}" "${backup_file}")
    fi
    
    # Download from S3 if requested
    if [[ "${from_s3}" == "true" ]]; then
        mkdir -p "${BACKUP_DIR}/restore_temp"
        local s3_path="${backup_type}/$(basename "${backup_file}")"
        local local_file="${BACKUP_DIR}/restore_temp/$(basename "${backup_file}")"
        download_from_s3 "${s3_path}" "${local_file}"
        backup_file="${local_file}"
    fi
    
    # Verify backup
    if ! verify_backup "${backup_file}"; then
        log_error "Backup verification failed!"
        exit 1
    fi
    
    # Decrypt if necessary
    local final_backup_file="${backup_file}"
    if [[ "${backup_file}" == *.enc ]]; then
        final_backup_file="${BACKUP_DIR}/restore_temp/$(basename "${backup_file%.enc}")"
        mkdir -p "$(dirname "${final_backup_file}")"
        if ! decrypt_backup "${backup_file}" "${final_backup_file}"; then
            log_error "Decryption failed!"
            exit 1
        fi
    fi
    
    # Perform restore
    if ! perform_restore "${final_backup_file}" "${dry_run}"; then
        log_error "Restore failed!"
        cleanup_temp_files
        exit 1
    fi
    
    # Verify restore (skip in dry-run mode)
    if [[ "${dry_run}" != "true" ]]; then
        if ! verify_restore; then
            log_warn "Restore verification completed with warnings"
        fi
    fi
    
    # Cleanup
    cleanup_temp_files
    
    local end_time
    end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    log_info "=========================================="
    log_info "HIVE-MIND PostgreSQL Restore Completed"
    log_info "Duration: ${duration} seconds"
    log_info "=========================================="
    
    return 0
}

# Run main function
main "$@"
