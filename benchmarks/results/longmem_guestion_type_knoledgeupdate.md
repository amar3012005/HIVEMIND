root@Blaiq-Amar-Dev:/opt/HIVEMIND# cd /opt/HIVEMIND && \
HIVEMIND_API_KEY="hmk_live_REDACTED" \
HIVEMIND_API_BASE="https://core.hivemind.davinciai.eu:8050" \
GROQ_API_KEY="gsk_REDACTED" \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
node benchmarks/LongMemEval/run-benchmark-sota.js 78 knowledge-update
╔══════════════════════════════════════════════════════╗
║  HIVEMIND × LongMemEval — FULL SOTA Engine          ║
╚══════════════════════════════════════════════════════╝
Features:
  - bge-m3 embeddings (1024-dim) via HIVEMIND server
  - MemoryProcessor fact extraction (exact user quotes)
  - Fact-memories with Extends relationships
  - Contextual embedding (factSentences enrich vector)
  - Operator Layer (intent + dynamic weights)
  - Graph expansion (Extends edges → parent chunks)
  - Parent chunk injection in /api/recall
  - eventDate extraction + storage
  - Generation: llama-3.3-70b-versatile
  - Sample: 78 (type: knowledge-update)

Loaded: 78 questions

(node:2530417) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
(Use `node --trace-warnings ...` to show where the warning was created)
Memories cleaned.

  ❌ [1/78] 6a1eabeb (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=0.0% (0/1) | ctx=1115ch | "I don't know. 

The context mentions two diff..." (11s)
  ✅ [2/78] 6aeb4375 (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=50.0% (1/2) | ctx=11360ch | "You've tried four different Korean restaurant..." (22s)
  ✅ [3/78] 830ce83f (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=66.7% (2/3) | ctx=12466ch | "She moved to Chicago, but then she moved back..." (31s)
  ❌ [4/78] 852ce960 (knowledge-update) | 2mem 8facts 1obs | intent:[object Object] | acc=50.0% (2/4) | ctx=12144ch | "The amount you were pre-approved for when you..." (40s)
  ✅ [5/78] 945e3d21 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=60.0% (3/5) | ctx=12737ch | "You attend yoga classes three times a week to..." (49s)
  ✅ [6/78] d7c942c3 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=66.7% (4/6) | ctx=10860ch | "Yes, your mom is using the same grocery list ..." (57s)
  ✅ [7/78] 71315a70 (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=71.4% (5/7) | ctx=859ch | "You've spent 10-12 hours on your abstract oce..." (66s)
  ✅ [8/78] 89941a93 (knowledge-update) | 2mem 10facts 0obs | intent:[object Object] | acc=75.0% (6/8) | ctx=1222ch | "You currently own 4 bikes: a road bike, a mou..." (77s)
  ✅ [9/78] ce6d2d27 (knowledge-update) | 2mem 8facts 1obs | intent:[object Object] | acc=77.8% (7/9) | ctx=12700ch | "You take a cocktail-making class on Fridays...." (86s)
  ✅ [10/78] 9ea5eabc (knowledge-update) | 2mem 5facts 2obs | intent:[object Object] | acc=80.0% (8/10) | ctx=1163ch | "Based on the retrieved context, the most rece..." (96s)
  ✅ [11/78] 07741c44 (knowledge-update) | 2mem 8facts 1obs | intent:[object Object] | acc=81.8% (9/11) | ctx=1020ch | "Under my bed...." (105s)
  ✅ [12/78] a1eacc2a (knowledge-update) | 2mem 3facts 2obs | intent:[object Object] | acc=83.3% (10/12) | ctx=764ch | "Since the most recent information about the n..." (114s)
  ✅ [13/78] 184da446 (knowledge-update) | 2mem 2facts 2obs | intent:[object Object] | acc=84.6% (11/13) | ctx=754ch | "You have read up to page 220 of 'A Short Hist..." (122s)
  ❌ [14/78] 031748ae (knowledge-update) | 2mem 8facts 0obs | intent:[object Object] | acc=78.6% (11/14) | ctx=13170ch | "When you just started your new role as Senior..." (133s)
  ✅ [15/78] 4d6b87c8 (knowledge-update) | 2mem 3facts 1obs | intent:[object Object] | acc=80.0% (12/15) | ctx=13560ch | "There are 25 titles currently on your to-watc..." (142s)
  ❌ [16/78] 0f05491a (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=75.0% (12/16) | ctx=11089ch | "To reach the gold level on your Starbucks Rew..." (152s)
  ✅ [17/78] 08e075c7 (knowledge-update) | 2mem 8facts 2obs | intent:[object Object] | acc=76.5% (13/17) | ctx=900ch | "You've been using your Fitbit Charge 3 for 9 ..." (163s)
  ❌ [18/78] f9e8c073 (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=72.2% (13/18) | ctx=996ch | "You attended three sessions of the bereavemen..." (172s)
  ✅ [19/78] 41698283 (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=73.7% (14/19) | ctx=1024ch | "The most recent information about a camera le..." (182s)
  ✅ [20/78] 2698e78f (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=75.0% (15/20) | ctx=12346ch | "You see Dr. Smith every week...." (190s)
  ✅ [21/78] b6019101 (knowledge-update) | 2mem 5facts 2obs | intent:[object Object] | acc=76.2% (16/21) | ctx=10423ch | "You've watched 5 MCU films in the last 3 mont..." (201s)
  ✅ [22/78] 45dc21b6 (knowledge-update) | 2mem 7facts 0obs | intent:[object Object] | acc=77.3% (17/22) | ctx=11594ch | "You've tried out 3 of Emma's recipes so far...." (210s)
  ✅ [23/78] 5a4f22c0 (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=78.3% (18/23) | ctx=12642ch | "Rachel is currently working at TechCorp...." (220s)
  ❌ [24/78] 6071bd76 (knowledge-update) | 2mem 5facts 1obs | intent:[object Object] | acc=75.0% (18/24) | ctx=12376ch | "You switched to more water per tablespoon of ..." (230s)
  ✅ [25/78] e493bb7c (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=76.0% (19/25) | ctx=1188ch | "The painting 'Ethereal Dreams' by Emma Taylor..." (238s)
  ✅ [26/78] 618f13b2 (knowledge-update) | 2mem 2facts 0obs | intent:[object Object] | acc=76.9% (20/26) | ctx=12914ch | "You've worn your new black Converse Chuck Tay..." (247s)
  ❌ [27/78] 72e3ee87 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=74.1% (20/27) | ctx=898ch | "To determine the number of episodes of the Sc..." (257s)
  ✅ [28/78] c4ea545c (knowledge-update) | 2mem 8facts 0obs | intent:[object Object] | acc=75.0% (21/28) | ctx=11963ch | "You go to the gym 4 times a week, on Tuesdays..." (267s)
  ❌ [29/78] 01493427 (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=72.4% (21/29) | ctx=990ch | "Since the last update on the postcard collect..." (276s)
  ✅ [30/78] 6a27ffc2 (knowledge-update) | 2mem 3facts 2obs | intent:[object Object] | acc=73.3% (22/30) | ctx=755ch | "You have completed 30 videos of Corey Schafer..." (284s)
  ✅ [31/78] 2133c1b5 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=74.2% (23/31) | ctx=12469ch | "You've been living in your current apartment ..." (292s)
API POST /api/recall: 502 — 
API POST /api/search/panorama: 502 — 
API DELETE /api/memories/delete-all?project=bench/sota/18bc8abd: 502 — 
  ❌ [32/78] 18bc8abd (knowledge-update) | 2mem 0facts 0obs | intent:? | acc=71.9% (23/32) | ctx=0ch | "I don't know...." (301s)
API POST /api/memories: 502 — 
API POST /api/memories: 502 — 
  ❌ [33/78] db467c8c (knowledge-update) | 0mem 0facts 0obs | intent:[object Object] | acc=69.7% (23/33) | ctx=0ch | "I don't know...." (307s)
  ✅ [34/78] 7a87bd0c (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=70.6% (24/34) | ctx=920ch | "You've been sticking to your daily tidying ro..." (315s)
  ❌ [35/78] e61a7584 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=68.6% (24/35) | ctx=13771ch | "You've had your cat, Luna, for about 6 months..." (323s)
  ✅ [36/78] 1cea1afa (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=69.4% (25/36) | ctx=959ch | "You currently have 600 followers on Instagram..." (333s)
  ✅ [37/78] ed4ddc30 (knowledge-update) | 2mem 3facts 2obs | intent:[object Object] | acc=70.3% (26/37) | ctx=690ch | "We currently have 20 dozen eggs stocked up in..." (341s)
  ❌ [38/78] 8fb83627 (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=68.4% (26/38) | ctx=8026ch | "You've finished reading 3 issues of National ..." (352s)
  ✅ [39/78] b01defab (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=69.2% (27/39) | ctx=11572ch | "Yes, you finished reading 'The Nightingale' b..." (361s)
  ✅ [40/78] 22d2cb42 (knowledge-update) | 2mem 8facts 0obs | intent:[object Object] | acc=70.0% (28/40) | ctx=12871ch | "You got your guitar serviced at the music sho..." (370s)
  ❌ [41/78] 0e4e4c46 (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=68.3% (28/41) | ctx=1017ch | "Your current highest score in Ticket to Ride ..." (379s)
  ✅ [42/78] 4b24c848 (knowledge-update) | 2mem 6facts 1obs | intent:[object Object] | acc=69.0% (29/42) | ctx=10832ch | "You've already got five tops from H&M so far...." (390s)
  ✅ [43/78] 7e974930 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=69.8% (30/43) | ctx=9797ch | "You earned $420 at the Downtown Farmers Marke..." (398s)
  ✅ [44/78] 603deb26 (knowledge-update) | 2mem 5facts 2obs | intent:[object Object] | acc=70.5% (31/44) | ctx=13852ch | "You've tried making a Negroni at home 10 time..." (614s)
  ✅ [45/78] 59524333 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=71.1% (32/45) | ctx=10689ch | "You usually go to the gym at 6:00 pm...." (623s)
  ✅ [46/78] 5831f84d (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=71.7% (33/46) | ctx=901ch | "You have watched 15 Crash Course videos in th..." (632s)
  ✅ [47/78] eace081b (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=72.3% (34/47) | ctx=1138ch | "You are planning to stay on Oahu for your bir..." (640s)
  ✅ [48/78] affe2881 (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=72.9% (35/48) | ctx=12337ch | "You have seen 32 different species of birds i..." (648s)
  ✅ [49/78] 50635ada (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=73.5% (36/49) | ctx=13907ch | "Before you got your current Premier Gold stat..." (656s)
  ❌ [50/78] e66b632c (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=72.0% (36/50) | ctx=1018ch | "I don't know. The context does not provide yo..." (666s)
  ✅ [51/78] 0ddfec37 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=72.5% (37/51) | ctx=1424ch | "I don't know. The most recent information abo..." (678s)
  ❌ [52/78] f685340e (knowledge-update) | 2mem 7facts 2obs | intent:[object Object] | acc=71.2% (37/52) | ctx=12799ch | "You play tennis with your friends at the loca..." (687s)
  ✅ [53/78] cc5ded98 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=71.7% (38/53) | ctx=1018ch | "You dedicate about two hours each day to codi..." (696s)
  ✅ [54/78] dfde3500 (knowledge-update) | 2mem 5facts 2obs | intent:[object Object] | acc=72.2% (39/54) | ctx=6381ch | "You meet with your previous language exchange..." (704s)
  ❌ [55/78] 69fee5aa (knowledge-update) | 2mem 5facts 1obs | intent:[object Object] | acc=70.9% (39/55) | ctx=12199ch | "You have at least one pre-1920 American coin ..." (716s)
  ✅ [56/78] 7401057b (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=71.4% (40/56) | ctx=13867ch | "You can redeem your accumulated points for 2 ..." (724s)
  ✅ [57/78] cf22b7bf (knowledge-update) | 1mem 1facts 1obs | intent:[object Object] | acc=71.9% (41/57) | ctx=328ch | "You've lost 10 pounds since you started going..." (836s)
  ❌ [58/78] a2f3aa27 (knowledge-update) | 2mem 6facts 1obs | intent:[object Object] | acc=70.7% (41/58) | ctx=12155ch | "You have 1250 followers on Instagram...." (845s)
  ✅ [59/78] c7dc5443 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=71.2% (42/59) | ctx=848ch | "Your current record in the recreational volle..." (854s)
  ✅ [60/78] 06db6396 (knowledge-update) | 2mem 5facts 1obs | intent:[object Object] | acc=71.7% (43/60) | ctx=762ch | "You have completed 5 projects since starting ..." (862s)
  ✅ [61/78] 3ba21379 (knowledge-update) | 2mem 5facts 1obs | intent:[object Object] | acc=72.1% (44/61) | ctx=732ch | "The type of vehicle model you are currently w..." (871s)
  ✅ [62/78] 9bbe84a2 (knowledge-update) | 2mem 5facts 2obs | intent:[object Object] | acc=72.6% (45/62) | ctx=13923ch | "Your previous goal for your Apex Legends leve..." (879s)
  ✅ [63/78] 10e09553 (knowledge-update) | 2mem 3facts 2obs | intent:[object Object] | acc=73.0% (46/63) | ctx=11164ch | "You caught 7 largemouth bass on your trip to ..." (888s)
  ✅ [64/78] dad224aa (knowledge-update) | 2mem 7facts 1obs | intent:[object Object] | acc=73.4% (47/64) | ctx=10981ch | "You wake up at 7:30 am on Saturdays...." (897s)
  ✅ [65/78] ba61f0b9 (knowledge-update) | 2mem 4facts 2obs | intent:[object Object] | acc=73.8% (48/65) | ctx=938ch | "There are 6 women on the team led by my forme..." (905s)
  ✅ [66/78] 42ec0761 (knowledge-update) | 2mem 7facts 0obs | intent:[object Object] | acc=74.2% (49/66) | ctx=13936ch | "You have a spare screwdriver that you picked ..." (914s)
  ✅ [67/78] 5c40ec5b (knowledge-update) | 2mem 5facts 2obs | intent:[object Object] | acc=74.6% (50/67) | ctx=10852ch | "You have met up with Alex from Germany twice ..." (923s)
  ❌ [68/78] c6853660 (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=73.5% (50/68) | ctx=1099ch | "You most recently decreased the limit on the ..." (933s)
  ✅ [69/78] 26bdc477 (knowledge-update) | 2mem 5facts 1obs | intent:[object Object] | acc=73.9% (51/69) | ctx=821ch | "You have taken your Canon EOS 80D camera on f..." (941s)
  ❌ [70/78] 0977f2af (knowledge-update) | 2mem 6facts 2obs | intent:[object Object] | acc=72.9% (51/70) | ctx=13128ch | "I don't know...." (951s)
  ✅ [71/78] 6aeb4375_abs (knowledge-update) | 2mem 6facts 0obs | intent:[object Object] | acc=73.2% (52/71) | ctx=10965ch | "I don't know...." (961s)
  ✅ [72/78] 031748ae_abs (knowledge-update) | 2mem 6facts 0obs | intent:[object Object] | acc=73.6% (53/72) | ctx=13013ch | "You just started your new role as Software En..." (970s)
  ✅ [73/78] 2698e78f_abs (knowledge-update) | 2mem 6facts 0obs | intent:[object Object] | acc=74.0% (54/73) | ctx=12066ch | "I don't know. The context does not mention Dr..." (979s)
  ✅ [74/78] 2133c1b5_abs (knowledge-update) | 2mem 7facts 2obs | intent:[object Object] | acc=74.3% (55/74) | ctx=12326ch | "You are not living in Shinjuku. You are livin..." (988s)
  ✅ [75/78] 0ddfec37_abs (knowledge-update) | 0mem 0facts 0obs | intent:[object Object] | acc=74.7% (56/75) | ctx=0ch | "I don't know...." (994s)
  ✅ [76/78] f685340e_abs (knowledge-update) | 0mem 0facts 0obs | intent:[object Object] | acc=75.0% (57/76) | ctx=0ch | "I don't know...." (1000s)
  ✅ [77/78] 89941a94 (knowledge-update) | 2mem 11facts 1obs | intent:[object Object] | acc=75.3% (58/77) | ctx=1626ch | "Before you purchased the gravel bike, you had..." (1010s)
  ✅ [78/78] 07741c45 (knowledge-update) | 2mem 8facts 0obs | intent:[object Object] | acc=75.6% (59/78) | ctx=13399ch | "You currently keep your old sneakers in a sho..." (1018s)

══════════════════════════════════════════════════════
  Result: 59/78 = 75.6%
  Duration: 1018s
══════════════════════════════════════════════════════
Output: /opt/HIVEMIND/benchmarks/LongMemEval/sota-output.jsonl