/** Explicit central ledger fixture for ingestion unit tests; erasure denial has separate tests. */
export function accountErasureAuthorityFixture() {
  const authority = {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async sql => sql.includes('INSERT INTO hivemind.account_ingestion_leases') ? [{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}] : [],
  };
  authority.$transaction = operation => operation(authority);
  return authority;
}
