---
when: an A/B, landing page, creative, or email test is about to be sized, stopped early, or declared a winner
---

EXPERIMENT POWER method (Kohavi, Tang & Xu, *Trustworthy Online Controlled Experiments*, 2020). The experiment contract fixes the process fields; this fixes the numbers. Run every check in order before the test launches.
1. MDE FIRST — declare the minimum detectable effect worth acting on before sizing anything. Without it, sample size is unknowable and any result is post-hoc.
2. SIZE IT — at 95% confidence and 80% power, required users per arm ≈ 16σ²/δ², where δ is the absolute MDE and σ² the metric variance (for a conversion rate p, σ² = p(1−p)). Compare that against real traffic in the window. If the traffic does not exist, say the test cannot be run and propose a bigger-swing intervention or a coarser metric — never launch underpowered and never report an underpowered null as "no difference".
3. FIXED HORIZON — commit to the stop point up front. Repeatedly checking a fixed-horizon p-value inflates false positives; stopping at the first green result is the single most common way marketing tests produce fake winners. If in-flight monitoring is required, use a sequential/always-valid method, declared in advance.
4. DURATION — at least two full weekly cycles, whole weeks only. For visible UI or creative changes, run past novelty and primacy decay before reading the effect.
5. SAMPLE RATIO MISMATCH — check observed split against intended. A ratio test at p < 0.001 means the instrumentation is broken; debug it, do not interpret the result.
6. REPORT — one pre-declared primary metric, absolute and relative effect with a confidence interval, plus n per arm. A bare "+18% lift" is not a result. Correct for multiplicity if several metrics are read.
7. TWYMAN'S LAW — any surprisingly large effect is more likely a tracking bug than a discovery. Verify before shipping it.
