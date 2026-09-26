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

export function authenticatedProfileBrief(userProfile: unknown, organizationProfile: unknown): string {
  const lines: string[] = [];
  if (userProfile && typeof userProfile === "object" && "context" in userProfile && typeof userProfile.context === "string" && userProfile.context.trim()) {
    lines.push("## Caller", userProfile.context.trim().slice(0, 1200));
  }
  const organization = organizationProfile && typeof organizationProfile === "object" && "organization" in organizationProfile
    ? organizationProfile.organization as { name?: unknown; company_profile?: Record<string, unknown> } | null
    : null;
  if (organization) {
    const clean = (value: unknown): string => typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 360) : "";
    const facts = Object.fromEntries(Object.entries(organization.company_profile ?? {}).map(([key, value]) =>
      [key.replace(/^company[:.]/i, "").replace(/-/g, "_"), value]));
    const fields: Array<[string, unknown]> = [
      ["Company", organization.name], ["Website", facts.website], ["Profile location", facts.location ?? facts.location_city],
      ["What it does", facts.what_it_does ?? facts.description], ["Mission", facts.mission],
      ["Audience", facts.audience ?? facts.icp], ["Positioning", facts.positioning], ["Voice", facts.voice],
    ];
    const selected = fields.map(([label, value]) => [label, clean(value)] as const).filter(([, value]) => value);
    if (selected.length) lines.push("## Organization", ...selected.map(([label, value]) => `${label}: ${value}`));
  }
  return lines.join("\n") || "Authenticated profile unavailable. Do not infer user or organization facts.";
}
