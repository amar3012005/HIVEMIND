export function companyFacts(profile: unknown, supplied: { company: string; website: string; market: string }) {
  const facts = profile && typeof profile === "object" && "facts" in profile && Array.isArray(profile.facts)
    ? profile.facts as Array<{ key?: unknown; value?: unknown }>
    : [];
  const values = new Map(facts.filter((fact) => typeof fact.key === "string" && typeof fact.value === "string")
    .map((fact) => [fact.key as string, (fact.value as string).trim()]));
  return {
    company: (values.get("company") || supplied.company).slice(0, 200),
    website: (values.get("company:website") || supplied.website).slice(0, 300),
    market: (values.get("company:location") || values.get("company:location_city") || supplied.market).slice(0, 200),
  };
}
