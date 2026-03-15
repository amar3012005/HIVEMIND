# Key Rotation Record

## Security Incident: Compromised Groq API Key

### 🔴 CRITICAL: Immediate Action Required

| Field | Value |
|-------|-------|
| **Key Type** | Groq API Key |
| **Key Pattern** | `YOUR_NEW_GROQ_KEY_HERE_ROTATE_IMMEDIATELY` |
| **Status** | **COMPROMISED** - Found in git history |
| **Rotation Date** | 2026-03-12 |
| **Severity** | CRITICAL |
| **Reason** | Hardcoded in test file (`tests/test-memory-engine.js`) and committed to git history |
| **Action Required** | Generate new key at https://console.groq.com/ |

---

## Affected Files

The following files contain the compromised key and **MUST** be updated:

| File | Line/Context | Status |
|------|--------------|--------|
| `project_status/STATUS.md` | Line 96, 135 | ⚠️ Requires update |
| `project_status/plans/TASKS.md` | Line 65 | ⚠️ Requires update |
| `project_status/plans/PROGRESS.md` | Line 12, 70 | ⚠️ Requires update |
| `project_status/plans/PHASE2_PROGRESS.md` | Line 12 | ⚠️ Requires update |
| `project_status/plans/PHASE2_PLAN.md` | Line 5, 120 | ⚠️ Requires update |
| `project_status/plans/GROQ_API.md` | Line 4, 12 | ⚠️ Requires update |
| `project_status/plans/PHASE2_COMPLETE.md` | Line 156 | ⚠️ Requires update |
| `UI_GUIDE.md` | Line 14 | ⚠️ Requires update |
| `LOCAL_RUNBOOK.md` | Line 61 | ⚠️ Requires update |
| `LOCAL_TESTING_GUIDE.md` | Line 148 | ⚠️ Requires update |
| `EMBEDDING_INTEGRATION_COMPLETE.md` | Line 74 | ⚠️ Requires update |

---

## Immediate Actions Taken

- [x] Key identified as compromised
- [x] Rotation record created
- [x] `.env.example` updated with security notice
- [ ] New key generated (requires manual action at Groq console)
- [ ] All file references updated
- [ ] Git history scrubbed (consider `git filter-branch` or BFG Repo-Cleaner)
- [ ] Old key revoked at Groq console
- [ ] New key deployed to production
- [ ] Audit log entry created

---

## Rotation Procedure

### Step 1: Generate New Key (Manual)

1. Log in to https://console.groq.com/
2. Navigate to API Keys section
3. Revoke the compromised key: `YOUR_NEW_GROQ_KEY_HERE_ROTATE_IMMEDIATELY`
4. Generate a new API key
5. Copy the new key securely

### Step 2: Update Environment Files

```bash
# Run the rotation script
./scripts/rotate-api-keys.sh

# Or manually update .env
cp .env.example .env
# Edit .env with your new GROQ_API_KEY
```

### Step 3: Update Documentation

Replace all instances of the old key pattern in documentation files:

```bash
# Find all references
grep -r "YOUR_NEW_GROQ_KEY_HERE_ROTATE_IMMEDIATELY" --include="*.md" .

# Replace with placeholder (DO NOT commit real keys)
find . -name "*.md" -type f -exec sed -i '' 's/YOUR_NEW_GROQ_KEY_HERE_ROTATE_IMMEDIATELY/your-new-groq-api-key-here/g' {} \;
```

### Step 4: Scrub Git History (Critical)

```bash
# Option A: Using BFG Repo-Cleaner (recommended)
bfg --delete-files '.env' --no-blob-protection
bfg --replace-text replacements.txt

# Option B: Using git filter-branch
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch -r .env' \
  --prune-empty --tag-name-filter cat -- --all

# Force push after scrubbing
git push --force --all
git push --force --tags
```

### Step 5: Verify Rotation

```bash
# Verify old key is no longer in codebase
grep -r "YOUR_NEW_GROQ_KEY_HERE_ROTATE_IMMEDIATELY" --exclude-dir=.git .

# Test new key
curl -X POST https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"test"}]}'
```

---

## Security Recommendations

### Prevent Future Exposure

1. **Never commit API keys to git**
   - Add `.env` to `.gitignore` (already done)
   - Use pre-commit hooks to scan for secrets

2. **Enable secret scanning**
   ```bash
   # Run the included secret scanner before commits
   ./scripts/scan-secrets.sh
   ```

3. **Use environment-specific keys**
   - Development: Limited scope, low rate limits
   - Production: Full scope, monitored usage
   - CI/CD: Separate key with minimal permissions

4. **Implement key rotation schedule**
   - Rotate API keys every 90 days
   - Document all rotations in this file

5. **Consider secret management**
   - HashiCorp Vault for production
   - AWS Secrets Manager / Azure Key Vault
   - GitHub Secrets for CI/CD

---

## Audit Trail

| Date | Action | Performed By | Status |
|------|--------|--------------|--------|
| 2026-03-12 | Key identified as compromised | Security Engineer | ✅ Complete |
| 2026-03-12 | Rotation record created | Security Engineer | ✅ Complete |
| 2026-03-12 | `.env.example` updated | Security Engineer | ✅ Complete |
| 2026-03-12 | Rotation script created | Security Engineer | ✅ Complete |
| 2026-03-12 | Pending: Key revoked at Groq | — | ⏳ Pending |
| 2026-03-12 | Pending: New key generated | — | ⏳ Pending |
| 2026-03-12 | Pending: Git history scrubbed | — | ⏳ Pending |

---

## Contact

For questions about this rotation, contact the security team.

**Classification:** CONFIDENTIAL  
**Retention:** 7 years (NIS2/DORA compliance)
