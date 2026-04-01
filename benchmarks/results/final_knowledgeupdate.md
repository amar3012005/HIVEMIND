root@Blaiq-Amar-Dev:/opt/HIVEMIND# CSI=0   GEN_MODEL=gemini-2.5-pro   GEN_BASE_URL=https://api.blaiq.ai/v1   GROQ_API_KEY="$LITELLM_KEY"   HIVEMIND_API_KEY=hmk_live_REDACTED   node benchmarks/LongMemEval/run-benchmark-csi.js 500 knowledge-update 2>1
╔══════════════════════════════════════════════════════════════╗
║  HIVEMIND × LongMemEval — FULL SOTA + CSI Engine            ║
╚══════════════════════════════════════════════════════════════╝

Memory Engine: bge-m3 (1024d) + BENCHMARK collection
  ✓ MemoryProcessor + Fact-memories + Contextual embedding
  ✓ Predict-Calibrate + Operator Layer + Bi-temporal
CSI: DISABLED
  ✗ Graph actions: merge, link, suppress, promote
  ✗ is_latest + importance + superseded dedup + turing-verified boost
Retrieval: Type-specific routing (6 strategies)
  ✓ preference_boost + include_superseded + graph expansion
Generation: gemini-2.5-pro
Sample: 500 (type: knowledge-update)

Loaded: 78 questions

  ✅ [1/78] 6a1eabeb (knowledge-update) | 2mem 6f 0tv | acc=100.0% (1/1) | "25:50..." (13s)
  ✅ [2/78] 6aeb4375 (knowledge-update) | 2mem 7f 0tv | acc=100.0% (2/2) | "You have tried four Korean restaurants in you..." (25s)
  ✅ [3/78] 830ce83f (knowledge-update) | 2mem 4f 0tv | acc=100.0% (3/3) | "Based on the most recent information, Rachel ..." (39s)
  ✅ [4/78] 852ce960 (knowledge-update) | 2mem 8f 0tv | acc=100.0% (4/4) | "$400,000..." (53s)
  ✅ [5/78] 945e3d21 (knowledge-update) | 2mem 8f 0tv | acc=100.0% (5/5) | "Three times a week...." (67s)
  ✅ [6/78] d7c942c3 (knowledge-update) | 2mem 6f 0tv | acc=100.0% (6/6) | "Yes, as of April 30, 2023, your mom is using ..." (81s)
  ✅ [7/78] 71315a70 (knowledge-update) | 2mem 4f 0tv | acc=100.0% (7/7) | "10-12 hours...." (98s)
  ✅ [8/78] 89941a93 (knowledge-update) | 2mem 10f 0tv | acc=100.0% (8/8) | "Four...." (111s)
  ✅ [9/78] ce6d2d27 (knowledge-update) | 2mem 8f 0tv | acc=100.0% (9/9) | "Fridays...." (128s)
  ✅ [10/78] 9ea5eabc (knowledge-update) | 2mem 6f 0tv | acc=100.0% (10/10) | "Paris..." (141s)
  ❌ [11/78] 07741c44 (knowledge-update) | 2mem 8f 0tv | acc=90.9% (10/11) | "In a shoe rack in your closet...." (155s)
  ✅ [12/78] a1eacc2a (knowledge-update) | 2mem 3f 0tv | acc=91.7% (11/12) | "7..." (170s)
  ✅ [13/78] 184da446 (knowledge-update) | 2mem 2f 0tv | acc=92.3% (12/13) | "220..." (184s)
  ❌ [14/78] 031748ae (knowledge-update) | 2mem 6f 0tv | acc=85.7% (12/14) | "You now lead five engineers. The provided con..." (197s)
  ✅ [15/78] 4d6b87c8 (knowledge-update) | 2mem 3f 0tv | acc=86.7% (13/15) | "25..." (210s)
  ❌ [16/78] 0f05491a (knowledge-update) | 2mem 8f 0tv | acc=81.3% (13/16) | "As of July 30, 2023, you need 12..." (228s)
  ✅ [17/78] 08e075c7 (knowledge-update) | 2mem 9f 0tv | acc=82.4% (14/17) | "9 months...." (246s)
  ❌ [18/78] f9e8c073 (knowledge-update) | 2mem 7f 0tv | acc=77.8% (14/18) | "Three...." (259s)
  ✅ [19/78] 41698283 (knowledge-update) | 2mem 5f 0tv | acc=78.9% (15/19) | "A 70-200mm zoom lens...." (273s)
  ✅ [20/78] 2698e78f (knowledge-update) | 2mem 7f 0tv | acc=80.0% (16/20) | "You see Dr. Smith every week...." (290s)
  ✅ [21/78] b6019101 (knowledge-update) | 2mem 8f 0tv | acc=81.0% (17/21) | "5..." (303s)
  ✅ [22/78] 45dc21b6 (knowledge-update) | 2mem 8f 0tv | acc=81.8% (18/22) | "3..." (316s)
  ✅ [23/78] 5a4f22c0 (knowledge-update) | 2mem 5f 0tv | acc=82.6% (19/23) | "TechCorp...." (337s)
  ❌ [24/78] 6071bd76 (knowledge-update) | 2mem 7f 0tv | acc=79.2% (19/24) | "You switched to more water per tablespoon of ..." (352s)
  ✅ [25/78] e493bb7c (knowledge-update) | 2mem 6f 0tv | acc=80.0% (20/25) | "In the bedroom...." (368s)
  ✅ [26/78] 618f13b2 (knowledge-update) | 2mem 2f 0tv | acc=80.8% (21/26) | "Six times...." (382s)
  ❌ [27/78] 72e3ee87 (knowledge-update) | 2mem 8f 0tv | acc=77.8% (21/27) | "Based on your plan to watch one episode daily..." (398s)
  ✅ [28/78] c4ea545c (knowledge-update) | 2mem 8f 0tv | acc=78.6% (22/28) | "Yes, you now go to the gym four times a week,..." (412s)
  ❌ [29/78] 01493427 (knowledge-update) | 2mem 4f 0tv | acc=75.9% (22/29) | "8..." (425s)
  ✅ [30/78] 6a27ffc2 (knowledge-update) | 2mem 2f 0tv | acc=76.7% (23/30) | "30..." (442s)
  ✅ [31/78] 2133c1b5 (knowledge-update) | 2mem 7f 0tv | acc=77.4% (24/31) | "3 months...." (456s)
  ✅ [32/78] 18bc8abd (knowledge-update) | 2mem 8f 0tv | acc=78.1% (25/32) | "Kansas City Masterpiece..." (478s)
  ✅ [33/78] db467c8c (knowledge-update) | 2mem 5f 0tv | acc=78.8% (26/33) | "Nine months...." (495s)
  ✅ [34/78] 7a87bd0c (knowledge-update) | 2mem 5f 0tv | acc=79.4% (27/34) | "4 weeks...." (519s)
  ❌ [35/78] e61a7584 (knowledge-update) | 2mem 7f 0tv | acc=77.1% (27/35) | "As of August 11, 2023, you had Luna for about..." (533s)
  ✅ [36/78] 1cea1afa (knowledge-update) | 2mem 6f 0tv | acc=77.8% (28/36) | "600..." (549s)
  ✅ [37/78] ed4ddc30 (knowledge-update) | 2mem 4f 0tv | acc=78.4% (29/37) | "20 dozen...." (562s)
  ✅ [38/78] 8fb83627 (knowledge-update) | 2mem 6f 0tv | acc=78.9% (30/38) | "Five...." (574s)
  ✅ [39/78] b01defab (knowledge-update) | 2mem 8f 0tv | acc=79.5% (31/39) | "Yes, you finished reading "The Nightingale" b..." (588s)
  ✅ [40/78] 22d2cb42 (knowledge-update) | 2mem 9f 0tv | acc=80.0% (32/40) | "You got your guitar serviced at the music sho..." (602s)
  ❌ [41/78] 0e4e4c46 (knowledge-update) | 2mem 5f 0tv | acc=78.0% (32/41) | "124 points...." (615s)
  ✅ [42/78] 4b24c848 (knowledge-update) | 2mem 8f 0tv | acc=78.6% (33/42) | "Five...." (629s)
  ✅ [43/78] 7e974930 (knowledge-update) | 2mem 7f 0tv | acc=79.1% (34/43) | "$420..." (644s)
  ✅ [44/78] 603deb26 (knowledge-update) | 2mem 5f 0tv | acc=79.5% (35/44) | "You have tried making a Negroni at home 10 ti..." (657s)
  ❌ [45/78] 59524333 (knowledge-update) | 2mem 7f 0tv | acc=77.8% (35/45) | "You usually go to the gym at 7:00 pm on Monda..." (672s)
  ✅ [46/78] 5831f84d (knowledge-update) | 2mem 4f 0tv | acc=78.3% (36/46) | "15..." (685s)
  ✅ [47/78] eace081b (knowledge-update) | 2mem 7f 0tv | acc=78.7% (37/47) | "Oahu...." (702s)
  ✅ [48/78] affe2881 (knowledge-update) | 2mem 8f 0tv | acc=79.2% (38/48) | "32..." (715s)
  ✅ [49/78] 50635ada (knowledge-update) | 2mem 7f 0tv | acc=79.6% (39/49) | "Based on the information provided, your previ..." (729s)
  ✅ [50/78] e66b632c (knowledge-update) | 2mem 8f 0tv | acc=80.0% (40/50) | "27 minutes and 45 seconds...." (743s)
  ✅ [51/78] 0ddfec37 (knowledge-update) | 2mem 3f 0tv | acc=80.4% (41/51) | "15..." (759s)
  ❌ [52/78] f685340e (knowledge-update) | 2mem 7f 0tv | acc=78.8% (41/52) | "Based on the most recent information from Jul..." (775s)
  ✅ [53/78] cc5ded98 (knowledge-update) | 2mem 7f 0tv | acc=79.2% (42/53) | "About two hours each day...." (787s)
  ✅ [54/78] dfde3500 (knowledge-update) | 2mem 7f 0tv | acc=79.6% (43/54) | "Wednesday evening...." (801s)
  ❌ [55/78] 69fee5aa (knowledge-update) | 2mem 5f 0tv | acc=78.2% (43/55) | "I don't know...." (816s)
  ✅ [56/78] 7401057b (knowledge-update) | 2mem 5f 0tv | acc=78.6% (44/56) | "Based on the most recent information from May..." (830s)
  ✅ [57/78] cf22b7bf (knowledge-update) | 2mem 11f 0tv | acc=78.9% (45/57) | "10 pounds...." (843s)
  ✅ [58/78] a2f3aa27 (knowledge-update) | 2mem 5f 0tv | acc=79.3% (46/58) | "You have close to 1300 followers...." (857s)
  ✅ [59/78] c7dc5443 (knowledge-update) | 2mem 5f 0tv | acc=79.7% (47/59) | "5-2..." (871s)
  ✅ [60/78] 06db6396 (knowledge-update) | 2mem 6f 0tv | acc=80.0% (48/60) | "5..." (887s)
  ✅ [61/78] 3ba21379 (knowledge-update) | 2mem 6f 0tv | acc=80.3% (49/61) | "Ford F-150 pickup truck...." (900s)
  ✅ [62/78] 9bbe84a2 (knowledge-update) | 2mem 5f 0tv | acc=80.6% (50/62) | "Your previous goal was to reach level 100 bef..." (915s)
  ✅ [63/78] 10e09553 (knowledge-update) | 2mem 4f 0tv | acc=81.0% (51/63) | "7..." (929s)
  ✅ [64/78] dad224aa (knowledge-update) | 2mem 9f 0tv | acc=81.3% (52/64) | "7:30 am...." (943s)
  ✅ [65/78] ba61f0b9 (knowledge-update) | 2mem 4f 0tv | acc=81.5% (53/65) | "6..." (959s)
  ✅ [66/78] 42ec0761 (knowledge-update) | 2mem 8f 0tv | acc=81.8% (54/66) | "Yes, you have a spare screwdriver that you fo..." (973s)
  ✅ [67/78] 5c40ec5b (knowledge-update) | 2mem 7f 0tv | acc=82.1% (55/67) | "Twice...." (987s)
  ✅ [68/78] c6853660 (knowledge-update) | 2mem 7f 0tv | acc=82.4% (56/68) | "You increased the limit to two cups...." (1002s)
  ✅ [69/78] 26bdc477 (knowledge-update) | 2mem 6f 0tv | acc=82.6% (57/69) | "Five...." (1016s)
  ✅ [70/78] 0977f2af (knowledge-update) | 2mem 5f 0tv | acc=82.9% (58/70) | "Instant Pot...." (1029s)
  ✅ [71/78] 6aeb4375_abs (knowledge-update) | 2mem 6f 0tv | acc=83.1% (59/71) | "I don't know...." (1041s)
  ❌ [72/78] 031748ae_abs (knowledge-update) | 2mem 6f 0tv | acc=81.9% (59/72) | "Based on the information from May 24, 2023, y..." (1056s)
  ❌ [73/78] 2698e78f_abs (knowledge-update) | 2mem 6f 0tv | acc=80.8% (59/73) | "I don't know...." (1072s)
  ❌ [74/78] 2133c1b5_abs (knowledge-update) | 2mem 6f 0tv | acc=79.7% (59/74) | "I don't know...." (1084s)
  ❌ [75/78] 0ddfec37_abs (knowledge-update) | 2mem 3f 0tv | acc=78.7% (59/75) | "I don't know...." (1098s)
  ✅ [76/78] f685340e_abs (knowledge-update) | 2mem 7f 0tv | acc=78.9% (60/76) | "I don't know. The context mentions playing te..." (1112s)
  ❌ [77/78] 89941a94 (knowledge-update) | 2mem 10f 0tv | acc=77.9% (60/77) | "I don't know...." (1127s)
  ✅ [78/78] 07741c45 (knowledge-update) | 2mem 8f 0tv | acc=78.2% (61/78) | "In a shoe rack in your closet...." (1140s)

══════════════════════════════════════════════════════════════
  Result: 61/78 = 78.2%
  Duration: 1140s | CSI: OFF (0 actions)
══════════════════════════════════════════════════════════════
Output: /opt/HIVEMIND/benchmarks/LongMemEval/csi-output-knowledge-update.jsonl

By type:
  knowledge-update: 61/78 = 78.2%
