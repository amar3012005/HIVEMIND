const NAMES = ['Luna', 'Sia', 'Clip', 'Kepler', 'Leo', 'Milo', 'Nova', 'Pico', 'Nori', 'Sol', 'Kiki', 'Echo', 'Lumi', 'Cleo', 'Remy', 'Rio'];

export function nameOnboardingTeam(hires, seed) {
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hires.map((hire, index) => ({ ...hire, name: NAMES[(hash + index) % NAMES.length] }));
}
