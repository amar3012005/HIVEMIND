# HIVE-MIND — Phase 3: SAP Rail Integration
## Enterprise Backbone (OData-First Architecture)

**Timeline:** 3–5 weeks  
**Scope:** OData service discovery, CSRF token handling, entity backfill, webhook activation, RFC phase-2 foundation  
**Deliverable:** OData backfill (1k+ Business Partner records) + trigger setup, CSRF validation, nested payload normalization  
**Strategic Value:** Highest lock-in for enterprise revenue; enables SAP → DATEV → CRM enrichment pipeline

---

## 📋 Phase Overview

**Why SAP Third?**
- Phase 1–2 establish memory engine + MCP bridge (platform foundation)
- Phases 3+ drive enterprise revenue (SAP, Salesforce, NetSuite)
- SAP chosen first due to ERP criticality, widespread DACH adoption, immediate customer demand

**Architecture Decision: OData First, RFC Later**
- **OData 2.0/4.0**: Vendor-supported, REST-native, CSRF-protected, pagination built-in
- **RFC phase-2** (Q3): HTTP-to-RFC ABAP wrapper (3000+ BAPI functions) as fallback + specialist toolkit
- **Community node risk mitigation**: n8n SAP connector unreliable; HTTP-Request + custom CSRF handling more maintainable

---

## 🎯 Phase 3 Milestones

### Milestone 1: OData Foundation (Week 1)
**Goal:** Auto-detect SAP system version, establish secure CSRF flow, discover entity catalog

#### Tasks
1. **SAP OData Node Development**
   - [ ] Detect OData v2 vs v4 from service root (`/sap/opu/odata/`)
   - [ ] CSRF token acquisition flow (GET request, extract header)
   - [ ] Service metadata document parser (entity sets, navigation properties)
   - [ ] Error handling: 403 CSRF, 401 auth, 502 gateway
   - [ ] Retry logic with exponential backoff (SAP Gateway timeout patterns)

2. **Connectivity Verification**
   - [ ] On-prem SAP via VPN: `--add-host=host.docker.internal:host-gateway` in Docker
   - [ ] Cloud SAP (S/4HANA): mTLS certificate pinning
   - [ ] Test matrix: SAP ERP 6.0, S/4HANA 2023/2025
   - [ ] Firewall rule documentation (SMB 139, HTTP 80, HTTPS 443)

3. **Configuration Structure**
   ```json
   {
     "sap": {
       "host": "${SAP_HOST}",
       "port": 8000,
       "client": "100",
       "user": "${SAP_USER}",
       "password": "${SAP_PASSWORD}",
       "odata_path": "/sap/opu/odata/sap",
       "allow_private_ips": true,
       "csrf_token_refresh_interval": 3600,
       "timeout_ms": 30000
     }
   }
   ```

---

### Milestone 2: Entity Backfill (Week 2–2.5)
**Goal:** Ingest canonical master data (Business Partner, Sales Orders, Purchase Orders, GL accounts)

#### Tasks
1. **Business Partner (BP) Backfill**
   - [ ] OData entity: `/C_BAPI_BUSINESS_PARTNER`
   - [ ] Select fields: `BusinessPartner`, `CompanyName`, `Country`, `CityName`, `PostalCode`, `TaxNumber`, `IndustryKey`
   - [ ] Pagination: `$skip=0&$top=1000` with loop until `__deferred` empty
   - [ ] Deduplication: hash on `BusinessPartner` + `CompanyName` + `Country`
   - [ ] Target: 1k+ records in HiveMind graph
   - [ ] Mapping to HiveMind schema:
     ```
     BusinessPartner {
       external_id: "sap://{client}/{BP}",
       type: "enterprise_contact",
       attributes: {
         name, country, tax_id, industry
       },
       tags: ["sap", "master_data", "business_partner"]
     }
     ```

2. **Sales Order (SO) Backfill**
   - [ ] OData entity: `/C_SALES_ORDER_TP` or `/C_SalesOrderList`
   - [ ] Select: `SalesOrder`, `SalesOrderDate`, `SoldToParty`, `TotalNetAmount`, `OrderStatus`, `to_Item` (navigation property)
   - [ ] Nested expand: `$expand=to_Item($select=Item,Material,OrderQuantity,UnitPrice)`
   - [ ] Time filter: last 90 days `SalesOrderDate ge datetime'2025-09-01T00:00:00'`
   - [ ] Line items flattening:
     ```
     SalesOrder {
       external_id: "sap://{client}/SO/{SalesOrder}",
       type: "sales_order",
       relationships: [
         { type: "customer", target: "sap://.../BP/{SoldToParty}" },
         { type: "line_item", target: "sap://.../SO/{SalesOrder}/Item/{Item}" }
       ],
       attributes: {
         date, total_net, status, line_items: [...]
       }
     }
     ```

3. **Purchase Order (PO) + Material Master**
   - [ ] `/C_PURCHASEORDER_TP` + items expand
   - [ ] Material master: `/C_MATERIAL_TP` (key for bill-of-materials queries)
   - [ ] GL master: `/C_GL_ACCOUNT` (for financial normalization)
   - [ ] 500–1000 records per entity backfill batch

4. **Data Normalization Pipeline**
   - [ ] SAP date format → ISO-8601 (`YYYYMMDD` → `YYYY-MM-DD`)
   - [ ] Nested line items unnest (convert `to_Item` arrays into separate nodes with relationships)
   - [ ] Currency normalization (map SAP currency key to ISO 4217)
   - [ ] Status code mapping (SAP `OrderStatus` → canonical enum: `OPEN`, `PARTIAL`, `COMPLETE`)

---

### Milestone 3: Webhook Activation (Week 2.5–3)
**Goal:** Real-time change notification via OData change subscriptions (v4) or polling fallback

#### Tasks
1. **OData v4 Change Data Capture (CDC)**
   - [ ] If SAP supports `/Delta` endpoint (S/4HANA 2021+):
     - Fetch delta token: GET `/C_SalesOrderTP?$deltatoken=0`
     - Store token per entity
     - Poll on interval (5–15 min), ingest only `__added`, `__modified`, `__deleted` nodes
   - [ ] Fallback (ERP 6.0, older S/4): full sync on interval, deduplicate via hash

2. **Webhook Handler Setup (n8n trigger)**
   - [ ] n8n webhook trigger on `POST /n8n/webhook/sap-change`
   - [ ] HMAC-SHA256 signature validation (shared secret from SAP system)
   - [ ] Payload: `{ entity_type, operation, record_id, timestamp }`
   - [ ] Idempotency check: deduplicate if same record processed within 60s
   - [ ] Dead-letter queue: failed payloads logged to PostgreSQL with retry bucket

3. **Polling Fallback (Reliability)**
   - [ ] Schedule trigger: every 5 min for high-velocity entities (SO, PO), every 30 min for masters
   - [ ] Query: `/C_SalesOrderTP?$filter=LastModifiedDateTime gt {last_sync_time}`
   - [ ] Store `last_sync_time` per entity in state table
   - [ ] Exponential backoff if SAP Gateway rate-limits (429, backoff up to 5 min)

4. **Delivery Confirmation Loop**
   - [ ] After ingesting change → emit HiveMind memory event
   - [ ] HiveMind triggers downstream enrichment (DATEV API call, CRM sentiment lookup)
   - [ ] Status callback: `PATCH /sap/{entity}/{id}/integration_status` → `PROCESSED`

---

### Milestone 4: Enrichment Pipeline (Week 3–4)
**Goal:** Augment SAP data with external signals (DATEV invoices, CRM sentiment, compliance)

#### Tasks
1. **DATEV Cross-Reference (Invoice Narrative)**
   - [ ] Query DATEV API: `/invoices?sap_vendor_id={TaxNumber}`
   - [ ] Extract narrative text, payment status, tax classification
   - [ ] Merge into SO/PO nodes:
     ```
     SalesOrder {
       relationships: [
         { type: "invoice", target: "datev://invoice/{id}", 
           attributes: { narrative, tax_code, payment_status } }
       ]
     }
     ```
   - [ ] Handle no-match gracefully (external_id mismatch)

2. **CRM Customer Sentiment (Salesforce/HubSpot)**
   - [ ] On Business Partner ingest: query CRM for matching account by `CompanyName` + `Country`
   - [ ] Extract sentiment, NPS, open cases, lifecycle stage
   - [ ] Tag BP node: `["sap", "crm_linked", "sentiment:{score}"]`
   - [ ] If CRM lookup fails: store `crm_lookup_error` in metadata, retry daily

3. **Compliance Tagging (DORA, NIS2)**
   - [ ] Query external risk database (e.g., Crunchbase, D&B): `TaxNumber`
   - [ ] Extract industry, employee count, financial health, regulatory flags
   - [ ] Auto-tag: `["enterprise", "regulated_{jurisdiction}", "risk_level:{low|medium|high}"]`

4. **Temporal Enrichment**
   - [ ] For each historical SO, compute cohort: "Q1 2025 sales volume by industry"
   - [ ] Store as derived relationships: `SalesOrder --[cohort_member]--> CohortAnalysis`

---

### Milestone 5: RFC Phase-2 Foundation (Week 4–5)
**Goal:** Design + prototype HTTP-to-RFC ABAP bridge for specialist tooling (payments, MRR, planning)

#### Tasks
1. **HTTP-to-RFC Wrapper Design**
   - [ ] Expose 3000+ BAPI functions as REST endpoints: `/rfc/{function_name}`
   - [ ] ABAP side: Z-function module, accepts HTTP POST (JSON) → RFC proxy → response JSON
   - [ ] Authentication: SAP Basic Auth or OAuth (mTLS via Gateway)
   - [ ] Call signature mapping: BAPI params → JSON struct → ABAP → return values
   - [ ] Spec example:
     ```
     POST /rfc/BAPI_BILL_OF_MATERIAL_GET
     {
       "material": "MAT001",
       "plant": "1000",
       "bom_usage": "1"
     }
     → Response: { bom_items: [...], status: "OK" }
     ```

2. **Pilot Functions (3–5 high-value BAPIs)**
   - [ ] `BAPI_SO_CREATE` — Sales order creation (full cycle testing)
   - [ ] `BAPI_INVOICE_CREATE` — Invoice posting
   - [ ] `BAPI_PO_CHANGE` — Purchase order modification
   - [ ] `SD_SALES_ANALYSIS` — Custom extraction routine
   - [ ] `BAPI_PRICING_RULE_GET` — Pricing logic introspection

3. **Fallback Integration in n8n**
   - [ ] If OData doesn't support operation (e.g., complex pricing, material planning), route to RFC
   - [ ] Decision node: "OData capable?" → yes: OData, no: RFC
   - [ ] Error recovery: RFC timeout → retry with exponential backoff, max 3 attempts

4. **Community Node Risk Mitigation**
   - [ ] Avoid n8n community SAP connector (unreliable, slow maintenance)
   - [ ] Document why: custom HTTP + CSRF + error handling > generic node
   - [ ] Provide migration path for existing workflows

---

## 🔧 Technical Implementation Details

### OData Node Implementation (n8n Custom Node)

**File:** `/n8n/nodes/sap-odata/SapOdata.node.ts`

```typescript
import {
  INodeType, INodeTypeDescription, NodeConnectionType,
  IExecuteFunctions, IDataObject
} from 'n8n-workflow';

export class SapOdata implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'SAP OData',
    name: 'sapOdata',
    group: ['transform'],
    version: 1,
    description: 'Read/write SAP entities via OData protocol',
    defaults: {
      name: 'SAP OData',
      color: '#00AA00',
    },
    inputs: [NodeConnectionType.Main],
    outputs: [NodeConnectionType.Main],
    credentials: [
      {
        name: 'sapBasicAuth',
        required: true,
        displayOptions: { show: { authType: ['basic'] } },
      },
    ],
    properties: [
      {
        displayName: 'SAP Host',
        name: 'sapHost',
        type: 'string',
        default: '',
        placeholder: 'sap.example.com',
        required: true,
      },
      {
        displayName: 'SAP Client',
        name: 'sapClient',
        type: 'string',
        default: '100',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        options: [
          { name: 'Fetch Entities', value: 'fetch' },
          { name: 'Create Entity', value: 'create' },
          { name: 'Update Entity', value: 'update' },
          { name: 'Delete Entity', value: 'delete' },
          { name: 'Discover Catalog', value: 'discover' },
        ],
        default: 'fetch',
      },
      {
        displayName: 'Entity Type',
        name: 'entityType',
        type: 'string',
        default: 'C_BAPI_BUSINESS_PARTNER',
        description: 'OData entity set (e.g., C_BAPI_BUSINESS_PARTNER)',
      },
      {
        displayName: 'Filter Expression',
        name: 'filterExpr',
        type: 'string',
        default: '',
        description: '$filter parameter (OData syntax)',
      },
      {
        displayName: 'Page Size',
        name: 'pageSize',
        type: 'number',
        default: 100,
      },
    ],
  };

  async execute(this: IExecuteFunctions) {
    const sapHost = this.getNodeParameter('sapHost', 0) as string;
    const sapClient = this.getNodeParameter('sapClient', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;

    const credentials = await this.getCredentials('sapBasicAuth');
    const basicAuth = Buffer.from(
      `${credentials.username}:${credentials.password}`
    ).toString('base64');

    const baseUrl = `https://${sapHost}:8000/sap/opu/odata/sap`;
    
    if (operation === 'discover') {
      return await this.discoverServiceMetadata(baseUrl, basicAuth);
    }
    
    if (operation === 'fetch') {
      return await this.fetchEntities(baseUrl, basicAuth);
    }

    // ... create, update, delete implementations
    return [];
  }

  private async discoverServiceMetadata(baseUrl: string, basicAuth: string) {
    // Auto-detect OData v2 vs v4
    // Parse $metadata document
    // Return entity sets + navigation properties
  }

  private async fetchEntities(baseUrl: string, basicAuth: string) {
    // Handle CSRF token refresh
    // Paginate through $top/$skip
    // Expand navigation properties
    // Normalize dates, currencies
    // Return flattened node array
  }
}
```

### CSRF Token Handler

**File:** `/core/src/sap/csrf-handler.js`

```javascript
class CsrfTokenManager {
  constructor(baseUrl, basicAuth) {
    this.baseUrl = baseUrl;
    this.basicAuth = basicAuth;
    this.token = null;
    this.expiresAt = null;
    this.refreshInterval = 3600000; // 1 hour
  }

  async getToken() {
    if (this.token && Date.now() < this.expiresAt) {
      return this.token;
    }
    await this.refreshToken();
    return this.token;
  }

  async refreshToken() {
    try {
      const response = await fetch(`${this.baseUrl}/$metadata`, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${this.basicAuth}`,
          'X-CSRF-Token': 'Fetch',
        },
      });
      
      this.token = response.headers.get('X-CSRF-Token');
      this.expiresAt = Date.now() + this.refreshInterval;
      
      if (!this.token) {
        throw new Error('CSRF token not returned by SAP');
      }
    } catch (error) {
      throw new Error(`CSRF token acquisition failed: ${error.message}`);
    }
  }

  async executeWithCsrf(method, url, body) {
    const token = await this.getToken();
    return fetch(url, {
      method,
      headers: {
        'Authorization': `Basic ${this.basicAuth}`,
        'X-CSRF-Token': token,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

module.exports = CsrfTokenManager;
```

### Data Normalization Pipeline

**File:** `/core/src/sap/normalize.js`

```javascript
class SapDataNormalizer {
  normalizeBusinessPartner(sapRecord) {
    return {
      external_id: `sap://${sapRecord.Client}/${sapRecord.BusinessPartner}`,
      type: 'enterprise_contact',
      attributes: {
        name: sapRecord.CompanyName,
        country: sapRecord.Country,
        city: sapRecord.CityName,
        postal_code: sapRecord.PostalCode,
        tax_number: sapRecord.TaxNumber,
        industry_key: sapRecord.IndustryKey,
      },
      tags: ['sap', 'master_data', 'business_partner'],
      created_at: new Date().toISOString(),
    };
  }

  normalizeSalesOrder(sapRecord) {
    const normalizedItems = (sapRecord.to_Item || []).map(item => ({
      external_id: `sap://${sapRecord.Client}/SO/${sapRecord.SalesOrder}/Item/${item.Item}`,
      type: 'sales_order_item',
      attributes: {
        material: item.Material,
        quantity: parseFloat(item.OrderQuantity),
        unit_price: parseFloat(item.UnitPrice),
        net_amount: parseFloat(item.NetAmount),
      },
      relationships: [
        {
          type: 'parent_order',
          target: `sap://${sapRecord.Client}/SO/${sapRecord.SalesOrder}`,
        },
      ],
    }));

    return {
      external_id: `sap://${sapRecord.Client}/SO/${sapRecord.SalesOrder}`,
      type: 'sales_order',
      attributes: {
        date: this.normalizeDateFromSap(sapRecord.SalesOrderDate),
        customer: sapRecord.SoldToParty,
        total_net: parseFloat(sapRecord.TotalNetAmount),
        currency: sapRecord.TransactionCurrency,
        status: this.normalizeStatus(sapRecord.OrderStatus),
        line_item_count: normalizedItems.length,
      },
      relationships: [
        {
          type: 'customer',
          target: `sap://${sapRecord.Client}/BP/${sapRecord.SoldToParty}`,
        },
        ...normalizedItems.map(item => ({
          type: 'line_item',
          target: item.external_id,
        })),
      ],
      tags: ['sap', 'sales_order', `status:${this.normalizeStatus(sapRecord.OrderStatus)}`],
      created_at: new Date().toISOString(),
    };
  }

  normalizeDateFromSap(sapDate) {
    // Handle both formats: YYYYMMDD (string) or /Date(milliseconds)/
    if (!sapDate) return null;
    
    if (sapDate.startsWith('/Date(')) {
      const ms = parseInt(sapDate.match(/\d+/)[0]);
      return new Date(ms).toISOString();
    }
    
    // YYYYMMDD format
    if (/^\d{8}$/.test(sapDate)) {
      const year = sapDate.substring(0, 4);
      const month = sapDate.substring(4, 6);
      const day = sapDate.substring(6, 8);
      return `${year}-${month}-${day}`;
    }
    
    return new Date(sapDate).toISOString();
  }

  normalizeStatus(sapStatus) {
    const statusMap = {
      'A': 'OPEN',
      'B': 'PARTIAL',
      'C': 'COMPLETE',
      'D': 'CANCELLED',
    };
    return statusMap[sapStatus] || sapStatus;
  }
}

module.exports = SapDataNormalizer;
```

---

## 🌐 Integration Points

### SAP → HiveMind Memory Flow

```
SAP OData Fetch
    ↓ (fetch entities, expand nav props)
CSRF Token Handler (acquire/refresh token)
    ↓ (add header to request)
HTTP Request (GET with pagination)
    ↓ (parse response, handle errors)
Data Normalizer (ISO dates, flatten nested items, status mapping)
    ↓ (convert SAP format → canonical schema)
HiveMind Memory Store (save_memory, create relationships)
    ↓ (store BP, SO, PO as nodes)
Enrichment Queue (trigger DATEV, CRM lookups)
    ↓ (async, non-blocking)
Webhook Event Emitter (notify downstream systems)
    ↓ (record processed, status = DONE)
```

### OData Change Notification → HiveMind Update

```
SAP Change Event (via webhook or delta poll)
    ↓ (PATCH SalesOrder, new TotalNetAmount)
Change Detector (compare old vs new hash)
    ↓ (detect modification)
HiveMind Update Memory
    ↓ (mark old node as superseded, create new version)
Trigger Enrichment Re-run (DATEV balance check, CRM pipeline update)
    ↓ (async)
Status Callback to SAP (PATCH /sap/SO/{id}/integration_status = PROCESSED)
```

---

## 📊 Success Metrics

| Metric | Target | Validation |
|--------|--------|-----------|
| **BP Records Ingested** | 1,000+ | Query HiveMind: `nodes.type='enterprise_contact'` count |
| **SO Records Ingested** | 500+ | Query: `nodes.type='sales_order'` count |
| **CSRF Token Refresh** | 100% success | Log: zero `X-CSRF-Token` acquisition failures over 1-week run |
| **Data Normalization** | 100% valid ISO-8601 dates | Validate all `attributes.date` matches regex `^\d{4}-\d{2}-\d{2}` |
| **Nested Item Flattening** | 100% parent–child linkage | Verify each `sales_order_item` has `relationships.parent_order` |
| **Webhook Latency** | <5s (parse → HiveMind ingest) | Monitor: timestamp delta (SAP change → HiveMind created_at) |
| **Idempotency** | Zero duplicates | Rerun same webhook payload 3x, verify node count unchanged |
| **Enrichment Coverage** | 80%+ BP → CRM linked | Query: nodes with tag `crm_linked` / total BP count |

---

## 🚀 Deployment Checklist

### Pre-Deployment
- [ ] SAP system access confirmed (VPN, on-prem or cloud)
- [ ] SAP Gateway logs reviewed (error patterns documented)
- [ ] Docker network configured: `--add-host=host.docker.internal:host-gateway` (on-prem)
- [ ] n8n SAP OData node installed in `/n8n/nodes/sap-odata/`
- [ ] DATEV API key provisioned
- [ ] CRM API credentials (Salesforce/HubSpot) ready
- [ ] PostgreSQL state table created: `sap_sync_state(entity_type, last_sync_time, last_success_at)`

### Deployment
- [ ] Deploy SAP OData custom node
- [ ] Create n8n workflow: "SAP BP Backfill"
- [ ] Create n8n workflow: "SAP SO Backfill"
- [ ] Create n8n workflow: "SAP Change Webhook"
- [ ] Create n8n trigger: "SAP Delta Poll (5 min)"
- [ ] Set env var: `ALLOW_PRIVATE_IPS=true` in n8n
- [ ] Test CSRF token refresh (manual curl, then automated)
- [ ] Run backfill on 10 records first (verify normalization)
- [ ] Backfill full dataset (1000 BP, 500 SO) — monitor logs

### Post-Deployment
- [ ] Verify 1000+ BP nodes in HiveMind
- [ ] Spot-check 10 nodes for correct date normalization
- [ ] Confirm webhook idempotency (3x resubmit, zero dups)
- [ ] Monitor RFC phase-2 design doc (share with SAP team)
- [ ] Document any SAP-specific gotchas (Gateway timeouts, CSRF rotation frequency, etc.)

---

## 📁 Deliverables

### Code
1. **SAP OData Custom Node** (`/n8n/nodes/sap-odata/SapOdata.node.ts`, ~300 LOC)
2. **CSRF Token Manager** (`/core/src/sap/csrf-handler.js`, ~100 LOC)
3. **Data Normalizer** (`/core/src/sap/normalize.js`, ~200 LOC)
4. **State Manager** (`/core/src/sap/state.js`, ~100 LOC)

### Workflows (n8n)
1. **SAP BP Backfill** (discovery, fetch, normalize, store)
2. **SAP SO Backfill** (with nested item expansion)
3. **SAP Change Webhook Handler** (ingest, deduplicate, enrich)
4. **SAP Delta Poll** (scheduled, 5-min intervals)

### Documentation
1. **Implementation Guide** (`/docs/SAP_PHASE3_IMPL.md`)
2. **Configuration Reference** (`/docs/SAP_CONFIG_REFERENCE.md`)
3. **RFC Phase-2 Design** (`/docs/RFC_PHASE2_DESIGN.md`)
4. **Troubleshooting Guide** (`/docs/SAP_TROUBLESHOOTING.md`)

### Tests
1. **CSRF Token Handler Tests** (~50 tests)
2. **Data Normalizer Tests** (~30 tests)
3. **OData Node Integration Tests** (~40 tests)

---

## 🎓 Learning & Skills

**Skills Gained:**
- OData 2.0/4.0 protocol (REST for SAP)
- CSRF token lifecycle & refresh patterns
- SAP authentication (Basic Auth, mTLS)
- RFC BAPI exposure via HTTP wrapper
- Nested payload normalization (flattening)
- Webhook idempotency patterns

**Technologies:**
- n8n custom nodes (TypeScript)
- SAP NetWeaver Gateway
- PostgreSQL state tracking
- HMAC signature validation

---

## 💡 Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| **SAP Gateway timeout (502)** | Exponential backoff (max 5 min), fallback to RFC |
| **CSRF token theft** | Token stored in-memory only, HTTPS enforced, rotate hourly |
| **Firewall blocking HTTP** | VPN tunnel tested pre-deployment, mTLS fallback if HTTPS fails |
| **Nested items explosion** | Pagination per item stream, batch flatten in 100-record chunks |
| **Drift between SAP ↔ HiveMind** | Checksum hash on each record, alert on mismatch |
| **DATEV/CRM lookup fail** | Graceful degradation: BP tagged `crm_lookup_error`, retry daily |
| **n8n community node unreliability** | Built custom node, no external dependency |

---

## 📈 Phase 3 → Phase 4 Roadmap

**Phase 4: Extended ERP Connectors** (Q3 2025)
- Salesforce connector (CRM → memory enrichment)
- NetSuite connector (financial consolidation)
- HubSpot connector (sales pipeline)
- Jira connector (project/issue sync)

**Phase 5: AI-Driven Insights** (Q3–Q4 2025)
- Anomaly detection: unexpected order patterns, cash flow signals
- Predictive supply chain (ML model on PO + forecast)
- Auto-generated audit trails (GxP compliance)
- Segment-level recommendation engine (upsell, retention)

---

## 👥 Team & Roles

| Role | Responsibility | Owner |
|------|--------------|-------|
| **SAP Architect** | OData discovery, RFC design, Gateway config | TBD |
| **n8n Developer** | Custom node, workflow orchestration | TBD |
| **Backend Engineer** | CSRF manager, data normalizer, state tracking | TBD |
| **QA Engineer** | Integration tests, CSRF refresh validation, backfill verification | TBD |
| **DevOps** | Docker config (private IPs), SAP Gateway logs, monitoring | TBD |

---

## 📞 Escalation & Contact

- **SAP Technical Issues**: SAP Basis team
- **OData/RFC Questions**: SAP NetWeaver documentation or Rampak consulting
- **n8n Custom Node**: n8n community forum or Airtable node examples
- **HiveMind Integration**: HIVE-MIND core team

---

**Last Updated:** 2026-06-02  
**Status:** Ready for Planning Phase  
**Next Step:** Assign roles, kick off Milestone 1 (OData Foundation)
