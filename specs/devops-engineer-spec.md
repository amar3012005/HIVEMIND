# Phase 1 Implementation Specification: DevOps Engineer

**Document Version:** 1.0.0  
**Role:** DevOps Engineer  
**Estimated Duration:** 10-14 days  
**Priority:** Critical (Infrastructure Foundation)  
**Compliance Reference:** CROSS_PLATFORM_SYNC_SPEC.md §1  

---

## Executive Summary

This specification defines the infrastructure implementation for HIVE-MIND's EU sovereign deployment. You will build a **production-ready containerized environment** using Docker Compose and Kubernetes (K3s), configure **Traefik v3.0** as the API gateway, implement **CI/CD pipelines** with GitHub Actions, and establish **monitoring, backup, and disaster recovery** procedures.

### Key Deliverables

1. ✅ `docker-compose.production.yml` (Hetzner/Scaleway ready)
2. ✅ Traefik v3.0 configuration (TLS, rate limiting, middleware)
3. ✅ Kubernetes manifests (K3s) for sovereign deployment
4. ✅ CI/CD pipeline (GitHub Actions)
5. ✅ Monitoring stack (Prometheus, Grafana, Sentry)
6. ✅ Backup & disaster recovery procedures
7. ✅ LUKS2 volume encryption setup

---

## 1. Environment Overview

### 1.1 Target Infrastructure

```
┌─────────────────────────────────────────────────────────────────┐
│                    EU Sovereign Cloud                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │   Hetzner DE    │  │  Scaleway FR    │  │   OVHcloud FR   │ │
│  │   (Compute)     │  │  (PostgreSQL)   │  │   (HSM/KMS)     │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘ │
│           │                    │                    │           │
│           └────────────────────┼────────────────────┘           │
│                                │                                │
│                    ┌───────────▼───────────┐                    │
│                    │   Traefik Gateway     │                    │
│                    │   (TLS Termination)   │                    │
│                    └───────────┬───────────┘                    │
│                                │                                │
│     ┌──────────────────────────┼──────────────────────────┐     │
│     │                          │                          │     │
│     ▼                          ▼                          ▼     │
│ ┌─────────┐              ┌─────────┐              ┌─────────┐   │
│ │  Core   │              │  Qdrant │              │  Redis  │   │
│ │  API    │              │ Vectors │              │  Cache  │   │
│ └────┬────┘              └────┬────┘              └────┬────┘   │
│      │                        │                        │        │
│      └────────────────────────┼────────────────────────┘        │
│                               │                                 │
│                    ┌──────────▼──────────┐                      │
│                    │  PostgreSQL + AGE   │                      │
│                    │  (LUKS2 Encrypted)  │                      │
│                    └─────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Hardware Requirements

| Component | Minimum | Production | Provider |
|-----------|---------|------------|----------|
| Compute Nodes | 4 vCPU, 8GB RAM | 8 vCPU, 32GB RAM | Hetzner AX52 |
| PostgreSQL | 4 vCPU, 16GB RAM | 8 vCPU, 64GB RAM | Scaleway PG-2XL |
| Qdrant | 4 vCPU, 8GB RAM | 8 vCPU, 32GB RAM | Self-hosted |
| Redis | 2 vCPU, 4GB RAM | 4 vCPU, 16GB RAM | Redis Cloud EU |
| Storage (PostgreSQL) | 100GB NVMe | 500GB NVMe | LUKS2 encrypted |
| Storage (Qdrant) | 50GB NVMe | 200GB NVMe | LUKS2 encrypted |

---

## 2. Docker Compose Production Configuration

### 2.1 Complete docker-compose.production.yml

```yaml
# File: infra/docker-compose.production.yml
# HIVE-MIND Production Stack - EU Sovereign
# Compatible: Hetzner, Scaleway, OVHcloud

version: '3.9'

x-logging: &default-logging
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
    compress: "true"

x-healthcheck: &pg-healthcheck
  test: ["CMD-SHELL", "pg_isready -U hivemind -d hivemind"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 30s

x-healthcheck: &redis-healthcheck
  test: ["CMD", "redis-cli", "ping"]
  interval: 10s
  timeout: 5s
  retries: 5

x-healthcheck: &qdrant-healthcheck
  test: ["CMD", "curl", "-f", "http://localhost:6333/"]
  interval: 10s
  timeout: 5s
  retries: 5

x-healthcheck: &api-healthcheck
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s

services:
  # ==========================================
  # API GATEWAY (Traefik v3.0)
  # ==========================================
  traefik:
    image: traefik:v3.0
    container_name: hivemind-traefik
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik:/etc/traefik:ro
      - ./certs:/certs:ro
      - traefik-acme:/acme
    environment:
      - CF_DNS_API_TOKEN=${CLOUDFLARE_DNS_API_TOKEN}
      - TRAEFIK_DASHBOARD_CREDENTIALS=${TRAEFIK_DASHBOARD_CREDENTIALS}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.traefik.rule=Host(`traefik.hivemind.io`)"
      - "traefik.http.routers.traefik.entrypoints=websecure"
      - "traefik.http.routers.traefik.tls=true"
      - "traefik.http.routers.traefik.service=api@internal"
      - "traefik.http.routers.traefik.middlewares=auth-dashboard"
      - "traefik.http.middlewares.auth-dashboard.basicauth.users=${TRAEFIK_DASHBOARD_CREDENTIALS}"
    networks:
      - hivemind-network
    logging: *default-logging

  # ==========================================
  # CORE API SERVICE
  # ==========================================
  api:
    image: hivemind/core:${VERSION:-latest}
    container_name: hivemind-api
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      qdrant:
        condition: service_healthy
    volumes:
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://hivemind:${POSTGRES_PASSWORD}@postgres:5432/hivemind?schema=public
      - REDIS_URL=redis://: ${REDIS_PASSWORD}@redis:6379
      - QDRANT_URL=http://qdrant:6333
      - QDRANT_API_KEY=${QDRANT_API_KEY}
      - ZITADEL_ISSUER_URL=${ZITADEL_ISSUER_URL}
      - ZITADEL_CLIENT_ID=${ZITADEL_CLIENT_ID}
      - ZITADEL_CLIENT_SECRET=${ZITADEL_CLIENT_SECRET}
      - HSM_MASTER_KEY=${HSM_MASTER_KEY}
      - LOG_LEVEL=info
      - LOG_FORMAT=json
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.api.rule=Host(`api.hivemind.io`)"
      - "traefik.http.routers.api.entrypoints=websecure"
      - "traefik.http.routers.api.tls=true"
      - "traefik.http.routers.api.tls.certresolver=letsencrypt"
      - "traefik.http.routers.api.service=api-service"
      - "traefik.http.routers.api.middlewares=rate-limit,security-headers"
      - "traefik.http.services.api-service.loadbalancer.server.port=3000"
      - "traefik.http.middlewares.rate-limit.ratelimit.burst=100"
      - "traefik.http.middlewares.rate-limit.ratelimit.average=50"
      - "traefik.http.middlewares.security-headers.headers.stsSeconds=31536000"
      - "traefik.http.middlewares.security-headers.headers.stsIncludeSubdomains=true"
      - "traefik.http.middlewares.security-headers.headers.stsPreload=true"
      - "traefik.http.middlewares.security-headers.headers.contentTypeNosniff=true"
      - "traefik.http.middlewares.security-headers.headers.frameDeny=true"
    healthcheck: *api-healthcheck
    networks:
      - hivemind-network
    logging: *default-logging
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M

  # ==========================================
  # POSTGRESQL 15 + APACHE AGE
  # ==========================================
  postgres:
    image: postgres:15-alpine
    container_name: hivemind-postgres
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./init-scripts:/docker-entrypoint-initdb.d:ro
      - ./backups:/backups
    environment:
      - POSTGRES_USER=hivemind
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=hivemind
      - POSTGRES_INITDB_ARGS=--encoding=UTF8 --lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8
      - PGDATA=/var/lib/postgresql/data/pgdata
    command: >
      postgres
      -c max_connections=200
      -c shared_buffers=2GB
      -c effective_cache_size=6GB
      -c maintenance_work_mem=512MB
      -c checkpoint_completion_target=0.9
      -c wal_buffers=16MB
      -c default_statistics_target=100
      -c random_page_cost=1.1
      -c effective_io_concurrency=200
      -c work_mem=10MB
      -c min_wal_size=1GB
      -c max_wal_size=4GB
      -c max_worker_processes=4
      -c max_parallel_workers_per_gather=2
      -c max_parallel_workers=4
      -c max_parallel_maintenance_workers=2
    healthcheck: *pg-healthcheck
    networks:
      - hivemind-network
    logging: *default-logging
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 8G

  # ==========================================
  # REDIS (Session & Pub/Sub)
  # ==========================================
  redis:
    image: redis:7-alpine
    container_name: hivemind-redis
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    command: >
      redis-server
      --requirepass ${REDIS_PASSWORD}
      --appendonly yes
      --maxmemory 1gb
      --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    healthcheck: *redis-healthcheck
    networks:
      - hivemind-network
    logging: *default-logging

  # ==========================================
  # QDRANT (Vector Database)
  # ==========================================
  qdrant:
    image: qdrant/qdrant:v1.7.0
    container_name: hivemind-qdrant
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    volumes:
      - qdrant-data:/qdrant/storage
      - qdrant-snapshots:/qdrant/snapshots
    environment:
      - QDRANT__SERVICE__GRPC_PORT=6334
      - QDRANT__REST__PORT=6333
      - QDRANT__STORAGE__STORAGE_PATH=/qdrant/storage
      - QDRANT__LOG_LEVEL=INFO
    command: >
      ./qdrant
      --config-path /qdrant/config/production.yaml
    healthcheck: *qdrant-healthcheck
    networks:
      - hivemind-network
    logging: *default-logging
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G

  # ==========================================
  # PROMETHEUS (Metrics)
  # ==========================================
  prometheus:
    image: prom/prometheus:v2.47.0
    container_name: hivemind-prometheus
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./prometheus/rules:/etc/prometheus/rules:ro
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=15d'
      - '--web.enable-lifecycle'
      - '--web.enable-admin-api'
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.prometheus.rule=Host(`metrics.hivemind.io`)"
      - "traefik.http.routers.prometheus.entrypoints=websecure"
      - "traefik.http.routers.prometheus.tls=true"
      - "traefik.http.routers.prometheus.middlewares=auth-monitoring"
    networks:
      - hivemind-network
    logging: *default-logging

  # ==========================================
  # GRAFANA (Dashboards)
  # ==========================================
  grafana:
    image: grafana/grafana:10.1.0
    container_name: hivemind-grafana
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
    environment:
      - GF_SECURITY_ADMIN_USER=${GRAFANA_ADMIN_USER}
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
      - GF_INSTALL_PLUGINS=grafana-piechart-panel
      - GF_SERVER_ROOT_URL=https://grafana.hivemind.io
      - GF_AUTH_ANONYMOUS_ENABLED=false
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.grafana.rule=Host(`grafana.hivemind.io`)"
      - "traefik.http.routers.grafana.entrypoints=websecure"
      - "traefik.http.routers.grafana.tls=true"
      - "traefik.http.routers.grafana.middlewares=auth-monitoring"
    depends_on:
      - prometheus
    networks:
      - hivemind-network
    logging: *default-logging

  # ==========================================
  # SENTRY (Error Tracking)
  # ==========================================
  sentry:
    image: sentry:23.11
    container_name: hivemind-sentry
    restart: unless-stopped
    depends_on:
      - postgres
      - redis
    environment:
      - SENTRY_SECRET_KEY=${SENTRY_SECRET_KEY}
      - POSTGRES_HOST=postgres
      - POSTGRES_PORT=5432
      - DB=postgres
      - POSTGRES_USER=hivemind
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=sentry
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_PASSWORD=${REDIS_PASSWORD}
      - SENTRY_MAIL_HOST=${SENTRY_MAIL_HOST}
      - SENTRY_OPTIONS__system.url-prefix=https://sentry.hivemind.io
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.sentry.rule=Host(`sentry.hivemind.io`)"
      - "traefik.http.routers.sentry.entrypoints=websecure"
      - "traefik.http.routers.sentry.tls=true"
    networks:
      - hivemind-network
    logging: *default-logging

  # ==========================================
  # BACKUP SERVICE
  # ==========================================
  backup:
    image: prodrigestivill/postgres-backup-local:15
    container_name: hivemind-backup
    restart: unless-stopped
    volumes:
      - ./backups:/backups
    environment:
      - POSTGRES_HOST=postgres
      - POSTGRES_DB=hivemind
      - POSTGRES_USER=hivemind
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - SCHEDULE=@daily
      - BACKUP_KEEP_DAYS=30
      - BACKUP_KEEP_WEEKS=4
      - BACKUP_KEEP_MONTHS=12
    networks:
      - hivemind-network
    logging: *default-logging

networks:
  hivemind-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16

volumes:
  postgres-data:
    driver: local
  redis-data:
    driver: local
  qdrant-data:
    driver: local
  qdrant-snapshots:
    driver: local
  prometheus-data:
    driver: local
  grafana-data:
    driver: local
  traefik-acme:
    driver: local
```

---

## 3. Traefik v3.0 Configuration

### 3.1 Static Configuration (traefik.yml)

```yaml
# File: infra/traefik/traefik.yml

# Global settings
global:
  checkNewVersion: false
  sendAnonymousUsage: false

# API and dashboard
api:
  dashboard: true
  insecure: false

# Entry points
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true

  websecure:
    address: ":443"
    http:
      tls:
        certResolver: letsencrypt
        domains:
          - main: "hivemind.io"
            sans:
              - "*.hivemind.io"
      middlewares:
        - security-headers@file

  metrics:
    address: ":8082"

# Providers
providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: hivemind-network
    watch: true

  file:
    directory: /etc/traefik
    watch: true

# Certificates
certificatesResolvers:
  letsencrypt:
    acme:
      email: ops@hivemind.io
      storage: /acme/acme.json
      caServer: https://acme-v02.api.letsencrypt.org/directory
      
      dnsChallenge:
        provider: cloudflare
        resolvers:
          - "1.1.1.1:53"
          - "8.8.8.8:53"
      
      # Zero downtime certificate renewal
      disablePropagationCheck: false

# Logging
log:
  level: INFO
  format: json
  filePath: /var/log/traefik/traefik.log

accessLog:
  level: INFO
  format: json
  filePath: /var/log/traefik/access.log
  
  filters:
    statusCodes:
      - "200-299"
      - "400-499"
      - "500-599"
  
  fields:
    defaultMode: keep
    headers:
      defaultMode: drop
      names:
        Authorization: drop
        Cookie: drop
        Set-Cookie: drop
        X-Api-Key: drop

# Metrics
metrics:
  prometheus:
    entryPoint: metrics
    addEntryPointsLabels: true
    addRoutersLabels: true
    addServicesLabels: true

# Ping for health checks
ping:
  entryPoint: web
```

### 3.2 Dynamic Configuration (middlewares.yml)

```yaml
# File: infra/traefik/dynamic/middlewares.yml

http:
  middlewares:
    # Security headers
    security-headers:
      headers:
        stsSeconds: 31536000
        stsIncludeSubdomains: true
        stsPreload: true
        forceSTSHeader: true
        contentTypeNosniff: true
        frameDeny: true
        referrerPolicy: "strict-origin-when-cross-origin"
        permissionsPolicy: "camera=(), microphone=(), geolocation=()"
        customFrameOptionsValue: "SAMEORIGIN"
        customResponseHeaders:
          X-Content-Type-Options: "nosniff"
          X-Frame-Options: "DENY"
          X-XSS-Protection: "1; mode=block"
          Cache-Control: "no-store, no-cache, must-revalidate, proxy-revalidate"
          Pragma: "no-cache"
          Expires: "0"

    # Rate limiting
    rate-limit-api:
      rateLimit:
        average: 100
        burst: 200
        period: 1m
        sourceCriterion:
          requestHeaderName: X-Forwarded-For

    rate-limit-strict:
      rateLimit:
        average: 20
        burst: 50
        period: 1m

    # Compression
    compress:
      compress:
        excludedContentTypes:
          - text/event-stream

    # IP whitelist (internal services)
    ip-whitelist-internal:
      ipWhiteList:
        sourceRange:
          - "172.28.0.0/16"
          - "10.0.0.0/8"

    # Basic auth for dashboards
    auth-monitoring:
      basicAuth:
        usersFile: /etc/traefik/.htpasswd

    # CORS for API
    cors-api:
      headers:
        accessControlAllowMethods:
          - "GET"
          - "POST"
          - "PUT"
          - "PATCH"
          - "DELETE"
          - "OPTIONS"
        accessControlAllowHeaders:
          - "Authorization"
          - "Content-Type"
          - "X-Request-ID"
          - "X-Api-Key"
        accessControlAllowOrigins:
          - "https://hivemind.io"
          - "https://app.hivemind.io"
        accessControlAllowCredentials: true
        accessControlMaxAge: 86400

    # Retry on errors
    retry:
      retry:
        attempts: 3
        initialInterval: 100ms

tcp:
  middlewares:
    # TCP rate limiting for database
    db-rate-limit:
      ipWhiteList:
        sourceRange:
          - "172.28.0.0/16"
```

### 3.3 TLS Configuration

```yaml
# File: infra/traefik/dynamic/tls.yml

tls:
  options:
    # Modern TLS configuration (TLS 1.3 only)
    modern:
      minVersion: VersionTLS13
      cipherSuites:
        - TLS_AES_128_GCM_SHA256
        - TLS_AES_256_GCM_SHA384
        - TLS_CHACHA20_POLY1305_SHA256
      sniStrict: true
      curvePreferences:
        - CurveP521
        - CurveP384

    # Intermediate TLS (TLS 1.2 + 1.3)
    intermediate:
      minVersion: VersionTLS12
      cipherSuites:
        - TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305
        - TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305
      sniStrict: true

    # Default (balanced compatibility)
    default:
      minVersion: VersionTLS12
      preferServerCipherSuites: true
```

---

## 4. Kubernetes Manifests (K3s)

### 4.1 Namespace and RBAC

```yaml
# File: infra/k8s/namespace.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: hivemind
  labels:
    name: hivemind
    environment: production
    compliance: eu-sovereign
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: hivemind-quota
  namespace: hivemind
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.cpu: "16"
    limits.memory: 32Gi
    persistentvolumeclaims: "10"
    secrets: "20"
    configmaps: "20"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: hivemind-limits
  namespace: hivemind
spec:
  limits:
  - default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    max:
      cpu: "4"
      memory: 8Gi
    min:
      cpu: 50m
      memory: 64Mi
    type: Container
```

### 4.2 PostgreSQL StatefulSet

```yaml
# File: infra/k8s/postgres-statefulset.yaml
---
apiVersion: v1
kind: Secret
metadata:
  name: postgres-credentials
  namespace: hivemind
type: Opaque
stringData:
  username: hivemind
  password: ${POSTGRES_PASSWORD}
  replication-password: ${REPLICATION_PASSWORD}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: hivemind
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi
  storageClassName: local-path
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: hivemind
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      securityContext:
        fsGroup: 999
      containers:
      - name: postgres
        image: postgres:15-alpine
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        - name: POSTGRES_DB
          value: hivemind
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
        - name: init-scripts
          mountPath: /docker-entrypoint-initdb.d
          readOnly: true
        resources:
          requests:
            cpu: 2
            memory: 4Gi
          limits:
            cpu: 4
            memory: 8Gi
        livenessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - hivemind
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 5
        readinessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - hivemind
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
      volumes:
      - name: init-scripts
        configMap:
          name: postgres-init
          defaultMode: 0755
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 500Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: hivemind
spec:
  clusterIP: None
  selector:
    app: postgres
  ports:
  - port: 5432
    targetPort: 5432
    name: postgres
```

### 4.3 API Deployment

```yaml
# File: infra/k8s/api-deployment.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hivemind-api
  namespace: hivemind
  labels:
    app: hivemind-api
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: hivemind-api
  template:
    metadata:
      labels:
        app: hivemind-api
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: hivemind-api
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
      - name: api
        image: hivemind/core:latest
        imagePullPolicy: Always
        ports:
        - containerPort: 3000
          name: http
          protocol: TCP
        env:
        - name: NODE_ENV
          value: production
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: hivemind-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: hivemind-secrets
              key: redis-url
        - name: QDRANT_URL
          value: http://qdrant.hivemind.svc.cluster.local:6333
        - name: ZITADEL_ISSUER_URL
          valueFrom:
            secretKeyRef:
              name: hivemind-secrets
              key: zitadel-issuer-url
        resources:
          requests:
            cpu: 250m
            memory: 512Mi
          limits:
            cpu: 1
            memory: 2Gi
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 30
          timeoutSeconds: 10
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
        volumeMounts:
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: tmp
        emptyDir: {}
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: hivemind-api
              topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: hivemind-api
  namespace: hivemind
  labels:
    app: hivemind-api
spec:
  type: ClusterIP
  ports:
  - port: 80
    targetPort: 3000
    protocol: TCP
    name: http
  selector:
    app: hivemind-api
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: hivemind-api-hpa
  namespace: hivemind
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: hivemind-api
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 4
        periodSeconds: 15
      selectPolicy: Max
```

### 4.4 Ingress Configuration

```yaml
# File: infra/k8s/ingress.yaml
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hivemind-ingress
  namespace: hivemind
  annotations:
    kubernetes.io/ingress.class: traefik
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
    traefik.ingress.kubernetes.io/router.tls.certresolver: letsencrypt
    traefik.ingress.kubernetes.io/router.middlewares: hivemind-rate-limit@kubernetescrd
spec:
  tls:
  - hosts:
    - api.hivemind.io
    - app.hivemind.io
    secretName: hivemind-tls
  rules:
  - host: api.hivemind.io
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: hivemind-api
            port:
              number: 80
  - host: app.hivemind.io
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: hivemind-frontend
            port:
              number: 80
```

---

## 5. CI/CD Pipeline (GitHub Actions)

### 5.1 Main CI/CD Workflow

```yaml
# File: .github/workflows/ci-cd.yml

name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
    tags: ['v*']
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}/core

jobs:
  # ==========================================
  # LINT & TEST
  # ==========================================
  lint-and-test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    
    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: hivemind_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
      
      redis:
        image: redis:7-alpine
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 6379:6379

    steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
        cache-dependency-path: core/package-lock.json

    - name: Install dependencies
      working-directory: ./core
      run: npm ci

    - name: Run linter
      working-directory: ./core
      run: npm run lint

    - name: Run type check
      working-directory: ./core
      run: npm run type-check

    - name: Run unit tests
      working-directory: ./core
      run: npm run test:unit
      env:
        CI: true

    - name: Run integration tests
      working-directory: ./core
      run: npm run test:integration
      env:
        DATABASE_URL: postgresql://test:test@localhost:5432/hivemind_test
        REDIS_URL: redis://localhost:6379

    - name: Upload coverage
      uses: codecov/codecov-action@v3
      with:
        directory: ./core/coverage

  # ==========================================
  # BUILD & PUSH
  # ==========================================
  build-and-push:
    needs: lint-and-test
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    permissions:
      contents: read
      packages: write
    
    steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Login to Container Registry
      uses: docker/login-action@v3
      with:
        registry: ${{ env.REGISTRY }}
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Extract metadata
      id: meta
      uses: docker/metadata-action@v5
      with:
        images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
        tags: |
          type=ref,event=branch
          type=ref,event=pr
          type=semver,pattern={{version}}
          type=semver,pattern={{major}}.{{minor}}
          type=sha,prefix=
          type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}

    - name: Build and push
      uses: docker/build-push-action@v5
      with:
        context: ./core
        file: ./core/Dockerfile
        push: true
        tags: ${{ steps.meta.outputs.tags }}
        labels: ${{ steps.meta.outputs.labels }}
        cache-from: type=gha
        cache-to: type=gha,mode=max
        platforms: linux/amd64,linux/arm64
        build-args: |
          BUILD_DATE=${{ github.event.head_commit.timestamp }}
          VCS_REF=${{ github.sha }}

    - name: Run Trivy vulnerability scanner
      uses: aquasecurity/trivy-action@master
      with:
        image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
        format: 'sarif'
        output: 'trivy-results.sarif'
        severity: 'CRITICAL,HIGH'

    - name: Upload Trivy scan results
      uses: github/codeql-action/upload-sarif@v2
      with:
        sarif_file: 'trivy-results.sarif'

  # ==========================================
  # DEPLOY TO STAGING
  # ==========================================
  deploy-staging:
    needs: build-and-push
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/develop'
    environment: staging
    
    steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Setup kubectl
      uses: azure/setup-kubectl@v3
      with:
        version: 'v1.28.0'

    - name: Configure kubeconfig
      run: |
        mkdir -p ~/.kube
        echo "${{ secrets.KUBECONFIG_STAGING }}" | base64 -d > ~/.kube/config

    - name: Deploy to staging
      run: |
        kubectl apply -f infra/k8s/namespace.yaml
        kubectl apply -f infra/k8s/
        kubectl set image deployment/hivemind-api api=ghcr.io/${{ github.repository }}/core:${{ github.sha }} -n hivemind
        kubectl rollout status deployment/hivemind-api -n hivemind --timeout=300s

    - name: Run smoke tests
      run: |
        ./scripts/smoke-tests.sh ${{ secrets.STAGING_URL }}

  # ==========================================
  # DEPLOY TO PRODUCTION
  # ==========================================
  deploy-production:
    needs: build-and-push
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    environment: production
    
    steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Setup kubectl
      uses: azure/setup-kubectl@v3
      with:
        version: 'v1.28.0'

    - name: Configure kubeconfig
      run: |
        mkdir -p ~/.kube
        echo "${{ secrets.KUBECONFIG_PRODUCTION }}" | base64 -d > ~/.kube/config

    - name: Deploy to production
      run: |
        kubectl apply -f infra/k8s/namespace.yaml
        kubectl apply -f infra/k8s/
        kubectl set image deployment/hivemind-api api=ghcr.io/${{ github.repository }}/core:${{ github.ref_name }} -n hivemind
        kubectl rollout status deployment/hivemind-api -n hivemind --timeout=600s

    - name: Run production smoke tests
      run: |
        ./scripts/smoke-tests.sh ${{ secrets.PRODUCTION_URL }}

    - name: Create Sentry release
      uses: getsentry/action-release@v1
      env:
        SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
        SENTRY_ORG: hivemind
        SENTRY_PROJECT: core
      with:
        environment: production
        version: ${{ github.ref_name }}

    - name: Notify deployment
      if: always()
      run: |
        curl -X POST ${{ secrets.SLACK_WEBHOOK }} \
          -H 'Content-Type: application/json' \
          -d "{
            \"text\": \"Production Deployment: ${{ github.ref_name }}\",
            \"attachments\": [{
              \"color\": \"${{ job.status == 'success' && 'good' || 'danger' }}\",
              \"fields\": [{
                \"title\": \"Status\",
                \"value\": \"${{ job.status }}\",
                \"short\": true
              }, {
                \"title\": \"Commit\",
                \"value\": \"${{ github.sha }}\",
                \"short\": true
              }]
            }]
          }"
```

### 5.2 Database Migration Workflow

```yaml
# File: .github/workflows/db-migrations.yml

name: Database Migrations

on:
  pull_request:
    paths:
      - 'core/prisma/**'
      - 'infra/db/migrations/**'

jobs:
  migration-check:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: hivemind_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
    - uses: actions/checkout@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: Install dependencies
      working-directory: ./core
      run: npm ci

    - name: Generate Prisma client
      working-directory: ./core
      run: npx prisma generate

    - name: Run migrations
      working-directory: ./core
      run: npx prisma migrate deploy
      env:
        DATABASE_URL: postgresql://test:test@localhost:5432/hivemind_test

    - name: Validate schema
      working-directory: ./core
      run: npx prisma validate
```

---

## 6. Monitoring Stack

### 6.1 Prometheus Configuration

```yaml
# File: infra/prometheus/prometheus.yml

global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: 'hivemind-production'
    environment: 'eu-sovereign'

alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:
  # Prometheus self-monitoring
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  # API service
  - job_name: 'hivemind-api'
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
            - hivemind
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
      - source_labels: [__meta_kubernetes_namespace]
        action: replace
        target_label: kubernetes_namespace
      - source_labels: [__meta_kubernetes_pod_name]
        action: replace
        target_label: kubernetes_pod_name

  # PostgreSQL
  - job_name: 'postgres'
    static_configs:
      - targets: ['postgres-exporter:9187']

  # Redis
  - job_name: 'redis'
    static_configs:
      - targets: ['redis-exporter:9121']

  # Qdrant
  - job_name: 'qdrant'
    static_configs:
      - targets: ['qdrant:6333']

  # Traefik
  - job_name: 'traefik'
    static_configs:
      - targets: ['traefik:8082']

  # Node exporter
  - job_name: 'node'
    static_configs:
      - targets: ['node-exporter:9100']
```

### 6.2 Alert Rules

```yaml
# File: infra/prometheus/rules/alerts.yml

groups:
  - name: hivemind-alerts
    interval: 30s
    rules:
      # API availability
      - alert: APIHighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5..", job="hivemind-api"}[5m])) 
          / sum(rate(http_requests_total{job="hivemind-api"}[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High API error rate"
          description: "Error rate is {{ $value | humanizePercentage }} (threshold: 5%)"

      # API latency
      - alert: APIHighLatency
        expr: |
          histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job="hivemind-api"}[5m])) by (le)) > 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High API latency"
          description: "P99 latency is {{ $value | humanizeDuration }} (threshold: 1s)"

      # Database connections
      - alert: PostgresHighConnections
        expr: |
          pg_stat_activity_count / pg_settings_max_connections > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "PostgreSQL connection pool near capacity"
          description: "{{ $value | humanizePercentage }} of connections in use"

      # Database replication lag
      - alert: PostgresReplicationLag
        expr: |
          pg_replication_lag > 30
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL replication lag"
          description: "Replication lag is {{ $value | humanizeDuration }}"

      # Memory pressure
      - alert: HighMemoryUsage
        expr: |
          (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage on {{ $labels.instance }}"
          description: "Memory usage is {{ $value | humanizePercentage }}"

      # Disk space
      - alert: LowDiskSpace
        expr: |
          (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.1
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Low disk space on {{ $labels.instance }}"
          description: "Only {{ $value | humanizePercentage }} disk space remaining"

      # Qdrant vector search latency
      - alert: QdrantHighLatency
        expr: |
          histogram_quantile(0.99, sum(rate(qdrant_search_duration_seconds_bucket[5m])) by (le)) > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Qdrant search latency high"
          description: "P99 search latency is {{ $value | humanizeDuration }}"

      # Backup failure
      - alert: BackupFailed
        expr: |
          postgres_backup_status != 1
        for: 1h
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL backup failed"
          description: "Last backup was not successful"
```

### 6.3 Grafana Dashboards

```yaml
# File: infra/grafana/provisioning/dashboards/hivemind-overview.json
{
  "dashboard": {
    "title": "HIVE-MIND Overview",
    "tags": ["hivemind", "production"],
    "timezone": "UTC",
    "panels": [
      {
        "id": 1,
        "title": "Request Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(rate(http_requests_total{job=\"hivemind-api\"}[5m]))",
            "legendFormat": "Requests/sec"
          }
        ],
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0}
      },
      {
        "id": 2,
        "title": "Error Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(rate(http_requests_total{job=\"hivemind-api\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{job=\"hivemind-api\"}[5m]))",
            "legendFormat": "Error Rate"
          }
        ],
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0}
      },
      {
        "id": 3,
        "title": "P99 Latency",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job=\"hivemind-api\"}[5m])) by (le))",
            "legendFormat": "P99"
          },
          {
            "expr": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job=\"hivemind-api\"}[5m])) by (le))",
            "legendFormat": "P95"
          }
        ],
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8}
      },
      {
        "id": 4,
        "title": "Database Connections",
        "type": "gauge",
        "targets": [
          {
            "expr": "pg_stat_activity_count",
            "legendFormat": "Active Connections"
          }
        ],
        "gridPos": {"h": 8, "w": 6, "x": 12, "y": 8}
      },
      {
        "id": 5,
        "title": "Memory Usage",
        "type": "graph",
        "targets": [
          {
            "expr": "container_memory_usage_bytes{container=\"api\"}",
            "legendFormat": "API Memory"
          }
        ],
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 16}
      },
      {
        "id": 6,
        "title": "Vector Search Performance",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.99, sum(rate(qdrant_search_duration_seconds_bucket[5m])) by (le))",
            "legendFormat": "Qdrant P99"
          }
        ],
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 16}
      }
    ],
    "refresh": "30s",
    "time": {
      "from": "now-1h",
      "to": "now"
    }
  }
}
```

---

## 7. Backup & Disaster Recovery

### 7.1 Backup Script

```bash
#!/bin/bash
# File: infra/backups/backup.sh
# HIVE-MIND Automated Backup Script

set -euo pipefail

# Configuration
BACKUP_DIR="/backups"
RETENTION_DAYS=30
RETENTION_WEEKS=4
RETENTION_MONTHS=12
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-hivemind}"
POSTGRES_USER="${POSTGRES_USER:-hivemind}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY}"

# Timestamps
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DATE_DAILY=$(date +%Y%m%d)
DATE_WEEKLY=$(date +%Y%m%d -d "last sunday")
DATE_MONTHLY=$(date +%Y%m%d -d "first day of last month")

# Logging
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Create backup directory
mkdir -p "${BACKUP_DIR}/daily" "${BACKUP_DIR}/weekly" "${BACKUP_DIR}/monthly"

log "Starting PostgreSQL backup..."

# Create backup
BACKUP_FILE="${BACKUP_DIR}/daily/${POSTGRES_DB}_${TIMESTAMP}.sql.gz"
pg_dump -h "${POSTGRES_HOST}" -U "${POSTGRES_USER}" "${POSTGRES_DB}" | gzip > "${BACKUP_FILE}"

# Encrypt backup if key is provided
if [[ -n "${ENCRYPTION_KEY}" ]]; then
    log "Encrypting backup..."
    openssl enc -aes-256-cbc -salt -pbkdf2 -in "${BACKUP_FILE}" -out "${BACKUP_FILE}.enc" -pass pass:"${ENCRYPTION_KEY}"
    rm "${BACKUP_FILE}"
    BACKUP_FILE="${BACKUP_FILE}.enc"
fi

log "Backup created: ${BACKUP_FILE}"

# Create weekly backup (if Sunday)
if [[ $(date +%u) -eq 7 ]]; then
    log "Creating weekly backup..."
    cp "${BACKUP_FILE}" "${BACKUP_DIR}/weekly/${POSTGRES_DB}_${DATE_WEEKLY}$(echo ${BACKUP_FILE} | grep -o '\.[^.]*$')"
fi

# Create monthly backup (if 1st of month)
if [[ $(date +%d) -eq 01 ]]; then
    log "Creating monthly backup..."
    cp "${BACKUP_FILE}" "${BACKUP_DIR}/monthly/${POSTGRES_DB}_${DATE_MONTHLY}$(echo ${BACKUP_FILE} | grep -o '\.[^.]*$')"
fi

# Cleanup old backups
log "Cleaning up old backups..."

# Daily backups
find "${BACKUP_DIR}/daily" -type f -mtime +${RETENTION_DAYS} -delete

# Weekly backups
find "${BACKUP_DIR}/weekly" -type f -mtime +$((RETENTION_WEEKS * 7)) -delete

# Monthly backups
find "${BACKUP_DIR}/monthly" -type f -mtime +$((RETENTION_MONTHS * 30)) -delete

# Verify backup integrity
log "Verifying backup integrity..."
if [[ "${BACKUP_FILE}" == *.enc ]]; then
    openssl enc -aes-256-cbc -d -pbkdf2 -in "${BACKUP_FILE}" -pass pass:"${ENCRYPTION_KEY}" | gunzip -t
else
    gunzip -t "${BACKUP_FILE}"
fi

log "Backup verification successful"

# Upload to remote storage (optional)
if [[ -n "${S3_BUCKET:-}" ]]; then
    log "Uploading to S3..."
    aws s3 cp "${BACKUP_FILE}" "s3://${S3_BUCKET}/hivemind/backups/"
fi

log "Backup completed successfully"
```

### 7.2 Disaster Recovery Plan

```markdown
# HIVE-MIND Disaster Recovery Plan

## Recovery Time Objective (RTO): 4 hours
## Recovery Point Objective (RPO): 24 hours

### Scenario 1: Database Corruption

1. **Assessment (15 min)**
   - Verify corruption extent
   - Check backup availability
   - Notify stakeholders

2. **Recovery Steps**
   ```bash
   # Stop application
   kubectl scale deployment hivemind-api --replicas=0 -n hivemind
   
   # Restore from latest backup
   gunzip -c /backups/daily/hivemind_20240101_000000.sql.gz | \
     psql -h postgres -U hivemind hivemind
   
   # Verify data integrity
   psql -h postgres -U hivemind hivemind -c "SELECT COUNT(*) FROM memories;"
   
   # Restart application
   kubectl scale deployment hivemind-api --replicas=3 -n hivemind
   ```

3. **Verification (30 min)**
   - Run smoke tests
   - Verify API endpoints
   - Check data consistency

### Scenario 2: Complete Infrastructure Loss

1. **Provision New Infrastructure**
   - Deploy new Hetzner/Scaleway servers
   - Install K3s cluster
   - Configure networking

2. **Restore from Backups**
   - Download latest backup from S3
   - Restore PostgreSQL
   - Restore Qdrant snapshots

3. **Update DNS**
   - Point DNS to new infrastructure
   - Wait for propagation
   - Verify TLS certificates

### Scenario 3: Data Breach

1. **Containment**
   - Rotate all credentials
   - Revoke compromised tokens
   - Isolate affected systems

2. **Assessment**
   - Review audit logs
   - Identify affected data
   - Determine breach scope

3. **Notification**
   - Notify affected users (GDPR: 72 hours)
   - Report to supervisory authority
   - Document incident
```

---

## 8. LUKS2 Volume Encryption

### 8.1 LUKS2 Setup Script

```bash
#!/bin/bash
# File: infra/encryption/setup-luks2.sh
# LUKS2 Volume Encryption for HIVE-MIND

set -euo pipefail

# Configuration
DEVICE="${1:-/dev/sdb}"
MOUNT_POINT="${2:-/data}"
ENCRYPTION_KEY_FILE="/etc/hivemind/luks-keyfile"
HSM_KEY_ID="${HSM_KEY_ID:-}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Verify device exists
if [[ ! -b "${DEVICE}" ]]; then
    log "ERROR: Device ${DEVICE} not found"
    exit 1
fi

# Install required packages
log "Installing required packages..."
apt-get update
apt-get install -y cryptsetup luks2

# Generate encryption key
log "Generating encryption key..."
mkdir -p /etc/hivemind
dd if=/dev/urandom of="${ENCRYPTION_KEY_FILE}" bs=512 count=4
chmod 600 "${ENCRYKEY_FILE}"

# Format with LUKS2
log "Formatting ${DEVICE} with LUKS2..."
cryptsetup luksFormat \
    --type luks2 \
    --cipher aes-xts-plain64 \
    --key-size 512 \
    --hash sha512 \
    --iter-time 5000 \
    --use-random \
    "${DEVICE}" \
    "${ENCRYPTION_KEY_FILE}"

# Open encrypted volume
log "Opening encrypted volume..."
cryptsetup open \
    --type luks2 \
    "${DEVICE}" \
    hivemind_data \
    --key-file "${ENCRYPTION_KEY_FILE}"

# Create filesystem
log "Creating ext4 filesystem..."
mkfs.ext4 /dev/mapper/hivemind_data

# Create mount point
mkdir -p "${MOUNT_POINT}"

# Mount volume
log "Mounting encrypted volume..."
mount /dev/mapper/hivemind_data "${MOUNT_POINT}"

# Configure fstab
log "Configuring fstab..."
UUID=$(blkid -s UUID -o value /dev/mapper/hivemind_data)
echo "UUID=${UUID} ${MOUNT_POINT} ext4 defaults,noatime 0 2" >> /etc/fstab

# Configure crypttab for boot
echo "hivemind_data ${DEVICE} ${ENCRYPTION_KEY_FILE} luks2,discard" >> /etc/crypttab

# Set permissions
chown -R 1000:1000 "${MOUNT_POINT}"
chmod 750 "${MOUNT_POINT}"

log "LUKS2 encryption setup complete"
log "Mount point: ${MOUNT_POINT}"
log "Device: /dev/mapper/hivemind_data"
```

### 8.2 HSM Integration (OVHcloud)

```bash
#!/bin/bash
# File: infra/encryption/hsm-integration.sh
# OVHcloud Managed HSM Integration

set -euo pipefail

# Configuration
HSM_ENDPOINT="${OVH_HSM_ENDPOINT}"
HSM_CLIENT_CERT="/etc/hivemind/hsm-client.pem"
HSM_CLIENT_KEY="/etc/hivemind/hsm-client-key.pem"
HSM_CA_CERT="/etc/hivemind/hsm-ca.pem"
KEY_LABEL="hivemind-master-key"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Generate master key in HSM
generate_hsm_key() {
    log "Generating master key in HSM..."
    
    pkcs11-tool \
        --module /usr/lib/softhsm/libsofthsm2.so \
        --login \
        --pin "${HSM_PIN}" \
        --keypairgen \
        --key-type rsa:4096 \
        --label "${KEY_LABEL}" \
        --id 01
    
    log "HSM key generated: ${KEY_LABEL}"
}

# Wrap LUKS key with HSM key
wrap_luks_key() {
    local LUKS_KEY_FILE="$1"
    local WRAPPED_KEY_FILE="$2"
    
    log "Wrapping LUKS key with HSM..."
    
    # Export HSM public key
    pkcs11-tool \
        --module /usr/lib/softhsm/libsofthsm2.so \
        --login \
        --pin "${HSM_PIN}" \
        --read-object \
        --label "${KEY_LABEL}" \
        --type pubkey \
        --output-file /tmp/hsm-pubkey.pem
    
    # Wrap LUKS key
    openssl rsautl -encrypt \
        -pubin -inkey /tmp/hsm-pubkey.pem \
        -in "${LUKS_KEY_FILE}" \
        -out "${WRAPPED_KEY_FILE}"
    
    log "LUKS key wrapped successfully"
}

# Unwrap LUKS key with HSM
unwrap_luks_key() {
    local WRAPPED_KEY_FILE="$1"
    local LUKS_KEY_FILE="$2"
    
    log "Unwrapping LUKS key with HSM..."
    
    pkcs11-tool \
        --module /usr/lib/softhsm/libsofthsm2.so \
        --login \
        --pin "${HSM_PIN}" \
        --decrypt \
        --input-file "${WRAPPED_KEY_FILE}" \
        --output-file "${LUKS_KEY_FILE}" \
        --id 01
    
    log "LUKS key unwrapped successfully"
}

# Main
case "${1:-}" in
    generate)
        generate_hsm_key
        ;;
    wrap)
        wrap_luks_key "$2" "$3"
        ;;
    unwrap)
        unwrap_luks_key "$2" "$3"
        ;;
    *)
        echo "Usage: $0 {generate|wrap|unwrap}"
        exit 1
        ;;
esac
```

---

## 9. Acceptance Criteria

### 9.1 Infrastructure Requirements

| ID | Requirement | Test Method | Pass Criteria |
|----|-------------|-------------|---------------|
| DO-01 | Docker Compose starts all services | `docker-compose up -d` | All containers healthy |
| DO-02 | Traefik routes traffic correctly | curl api.hivemind.io | 200 response |
| DO-03 | TLS certificates auto-renew | Check cert expiry | >30 days validity |
| DO-04 | K3s cluster deploys successfully | `kubectl get nodes` | All nodes Ready |
| DO-05 | HPA scales API pods | Load test | Pods scale 2→10 |
| DO-06 | Prometheus scrapes all targets | Check targets page | All targets UP |
| DO-07 | Alerts fire correctly | Simulate failure | Alert in Grafana |
| DO-08 | Backup completes successfully | Run backup script | Backup file created |
| DO-09 | Restore from backup works | Restore test | Data integrity verified |
| DO-10 | LUKS2 encryption active | `cryptsetup status` | LUKS2 confirmed |

### 9.2 Performance Requirements

| Metric | Target | Measurement |
|--------|--------|-------------|
| API startup time | <60s | Container start to ready |
| Database restore time | <30 min | 100GB dataset |
| Backup throughput | >50 MB/s | pg_dump speed |
| Traefik latency | <10ms | P99 request routing |

### 9.3 Security Requirements

| ID | Requirement | Verification |
|----|-------------|--------------|
| SEC-01 | All containers run as non-root | `docker exec user` |
| SEC-02 | Network policies enforced | Test cross-namespace access |
| SEC-03 | Secrets not in images | Scan with Trivy |
| SEC-04 | LUKS2 encryption at rest | `cryptsetup luksDump` |

---

## 10. Testing Instructions

### 10.1 Local Testing

```bash
# Start full stack
cd infra
docker-compose -f docker-compose.production.yml up -d

# Check health
docker-compose ps

# View logs
docker-compose logs -f api

# Test API
curl -k https://localhost/health
```

### 10.2 Load Testing

```bash
# Install k6
brew install k6

# Run load test
k6 run tests/load/infrastructure.js

# Stress test
k6 run --vus 1000 --duration 10m tests/load/infrastructure.js
```

### 10.3 Backup/Restore Test

```bash
# Create test data
psql -h localhost -U hivemind hivemind -c "INSERT INTO memories (content) VALUES ('test');"

# Run backup
./backups/backup.sh

# Restore
gunzip -c backups/daily/*.sql.gz | psql -h localhost -U hivemind hivemind

# Verify
psql -h localhost -U hivemind hivemind -c "SELECT COUNT(*) FROM memories;"
```

---

## 11. Environment Variables

```bash
# Infrastructure
VERSION=latest
CLOUDFLARE_DNS_API_TOKEN=your-token
TRAEFIK_DASHBOARD_CREDENTIALS='$$apr1$$xyz$$abc'

# Database
POSTGRES_PASSWORD=secure-password-here
REPLICATION_PASSWORD=secure-replication-password

# Redis
REDIS_PASSWORD=secure-redis-password

# Qdrant
QDRANT_API_KEY=secure-qdrant-key

# ZITADEL
ZITADEL_ISSUER_URL=https://auth.hivemind.io
ZITADEL_CLIENT_ID=client-id
ZITADEL_CLIENT_SECRET=client-secret

# Encryption
HSM_MASTER_KEY=from-vault
BACKUP_ENCRYPTION_KEY=secure-backup-key

# Monitoring
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=secure-grafana-password
SENTRY_SECRET_KEY=secure-sentry-key
SENTRY_MAIL_HOST=smtp.hivemind.io
```

---

## 12. References

- [CROSS_PLATFORM_SYNC_SPEC.md](../CROSS_PLATFORM_SYNC_SPEC.md)
- [Traefik v3.0 Documentation](https://doc.traefik.io/traefik/)
- [K3s Documentation](https://docs.k3s.io/)
- [PostgreSQL 15 Documentation](https://www.postgresql.org/docs/15/)
- [LUKS2 Specification](https://gitlab.com/cryptsetup/cryptsetup/-/wikis/LUKS2)
- [EU Cloud Sovereignty Guidelines](https://digital-strategy.ec.europa.eu/)

---

**Document Approval:**

| Role | Name | Date | Signature |
|------|------|------|-----------|
| DevOps Lead | | | |
| Security Engineer | | | |
| Backend Lead | | | |
