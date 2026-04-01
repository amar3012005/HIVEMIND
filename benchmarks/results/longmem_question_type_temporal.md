root@Blaiq-Amar-Dev:/opt/HIVEMIND# # Temporal-reasoning (baseline: 78.3% → target 80%+)
cd /opt/HIVEMIND && \
HIVEMIND_API_KEY="hmk_live_REDACTED" \ 
HIVEMIND_API_BASE="https://core.hivemind.davinciai.eu:8050" \
GROQ_API_KEY="gsk_REDACTED" \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
node benchmarks/LongMemEval/run-benchmark-sota.js 60 temporal-reasoning
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
  - Sample: 60 (type: temporal-reasoning)

Loaded: 60 questions

(node:2331916) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
(Use `node --trace-warnings ...` to show where the warning was created)
Memories cleaned.

  ✅ [1/60] gpt4_2655b836 (temporal-reasoning) | 3mem 5facts 1obs | intent:[object Object] | acc=100.0% (1/1) | ctx=910ch | "To determine the first issue you had with you..." (8s)
  ❌ [2/60] gpt4_2487a7cb (temporal-reasoning) | 2mem 5facts 1obs | intent:[object Object] | acc=50.0% (1/2) | ctx=1011ch | "To determine which event you attended first, ..." (15s)
  ✅ [3/60] gpt4_76048e76 (temporal-reasoning) | 2mem 7facts 1obs | intent:[object Object] | acc=66.7% (2/3) | ctx=1048ch | "To determine which vehicle you took care of f..." (23s)
  ✅ [4/60] gpt4_2312f94c (temporal-reasoning) | 2mem 8facts 1obs | intent:[object Object] | acc=75.0% (3/4) | ctx=1424ch | "To determine which device you got first, let'..." (30s)
  ✅ [5/60] 0bb5a684 (temporal-reasoning) | 2mem 4facts 2obs | intent:[object Object] | acc=80.0% (4/5) | ctx=1073ch | "To find out how many days before the team mee..." (36s)
  ✅ [6/60] 08f4fc43 (temporal-reasoning) | 2mem 4facts 2obs | intent:[object Object] | acc=83.3% (5/6) | ctx=1004ch | "To find out how many days had passed between ..." (44s)
  ❌ [7/60] 2c63a862 (temporal-reasoning) | 2mem 8facts 0obs | intent:[object Object] | acc=71.4% (5/7) | ctx=842ch | "To find out how many days it took for you to ..." (50s)
  ✅ [8/60] gpt4_385a5000 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=75.0% (6/8) | ctx=9243ch | "To determine which seeds were started first, ..." (60s)
  ✅ [9/60] 2a1811e2 (temporal-reasoning) | 2mem 5facts 2obs | intent:[object Object] | acc=77.8% (7/9) | ctx=13485ch | "To find out how many days had passed between ..." (71s)
  ✅ [10/60] bbf86515 (temporal-reasoning) | 2mem 7facts 1obs | intent:[object Object] | acc=80.0% (8/10) | ctx=1068ch | "To find out how many days before the 'Rack Fe..." (78s)
  ❌ [11/60] gpt4_5dcc0aab (temporal-reasoning) | 5mem 0facts 0obs | intent:[object Object] | acc=72.7% (8/11) | ctx=0ch | "I don't know...." (90s)
  ❌ [12/60] gpt4_0b2f1d21 (temporal-reasoning) | 2mem 1facts 2obs | intent:[object Object] | acc=66.7% (8/12) | ctx=370ch | "To determine which event happened first, we n..." (97s)
  ✅ [13/60] f0853d11 (temporal-reasoning) | 2mem 5facts 2obs | intent:[object Object] | acc=69.2% (9/13) | ctx=1232ch | "To find out how many days had passed between ..." (105s)
  ✅ [14/60] gpt4_6ed717ea (temporal-reasoning) | 2mem 4facts 2obs | intent:[object Object] | acc=71.4% (10/14) | ctx=929ch | "To determine which item was purchased first, ..." (114s)
  ✅ [15/60] gpt4_70e84552 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=73.3% (11/15) | ctx=711ch | "To determine which task was completed first, ..." (122s)
  ✅ [16/60] a3838d2b (temporal-reasoning) | 6mem 9facts 5obs | intent:[object Object] | acc=75.0% (12/16) | ctx=1928ch | "To determine how many charity events you part..." (137s)
  ❌ [17/60] gpt4_93159ced (temporal-reasoning) | 2mem 9facts 0obs | intent:[object Object] | acc=70.6% (12/17) | ctx=847ch | "To determine how long you've been working bef..." (143s)
  ✅ [18/60] gpt4_2d58bcd6 (temporal-reasoning) | 2mem 6facts 2obs | intent:[object Object] | acc=72.2% (13/18) | ctx=1626ch | "To determine which book was finished first, '..." (152s)
  ✅ [19/60] gpt4_65aabe59 (temporal-reasoning) | 2mem 5facts 2obs | intent:[object Object] | acc=73.7% (14/19) | ctx=1271ch | "To determine which device was set up first, w..." (161s)
  ❌ [20/60] 982b5123 (temporal-reasoning) | 2mem 6facts 1obs | intent:[object Object] | acc=70.0% (14/20) | ctx=1054ch | "To determine how many months ago the Airbnb i..." (168s)
  ✅ [21/60] b9cfe692 (temporal-reasoning) | 3mem 8facts 1obs | intent:[object Object] | acc=71.4% (15/21) | ctx=13948ch | "To calculate the total time it took to finish..." (177s)
  ✅ [22/60] gpt4_4edbafa2 (temporal-reasoning) | 2mem 6facts 2obs | intent:[object Object] | acc=72.7% (16/22) | ctx=1337ch | "To find the date on which you attended the fi..." (184s)
  ✅ [23/60] c8090214 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=73.9% (17/23) | ctx=13418ch | "To find out how many days before you bought t..." (193s)
  ❌ [24/60] gpt4_483dd43c (temporal-reasoning) | 2mem 8facts 1obs | intent:[object Object] | acc=70.8% (17/24) | ctx=1133ch | "To determine which show you started watching ..." (200s)
  ✅ [25/60] e4e14d04 (temporal-reasoning) | 2mem 7facts 0obs | intent:[object Object] | acc=72.0% (18/25) | ctx=1001ch | "To find out how long you had been a member of..." (208s)
  ✅ [26/60] c9f37c46 (temporal-reasoning) | 2mem 5facts 1obs | intent:[object Object] | acc=73.1% (19/26) | ctx=869ch | "To determine how long I had been watching sta..." (217s)
  ✅ [27/60] gpt4_2c50253f (temporal-reasoning) | 2mem 2facts 0obs | intent:[object Object] | acc=74.1% (20/27) | ctx=413ch | "To determine your wake-up time on Tuesdays an..." (224s)
  ✅ [28/60] dcfa8644 (temporal-reasoning) | 2mem 6facts 0obs | intent:[object Object] | acc=75.0% (21/28) | ctx=13924ch | "To find out how many days had passed since yo..." (234s)
  ✅ [29/60] gpt4_b4a80587 (temporal-reasoning) | 2mem 5facts 2obs | intent:[object Object] | acc=75.9% (22/29) | ctx=1013ch | "To determine which event happened first, we n..." (241s)
  ✅ [30/60] gpt4_9a159967 (temporal-reasoning) | 3mem 7facts 1obs | intent:[object Object] | acc=76.7% (23/30) | ctx=1267ch | "To determine which airline you flew with the ..." (250s)
  ✅ [31/60] cc6d1ec1 (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=77.4% (24/31) | ctx=512ch | "To determine how long I had been bird watchin..." (256s)
  ✅ [32/60] gpt4_8c8961ae (temporal-reasoning) | 2mem 7facts 2obs | intent:[object Object] | acc=78.1% (25/32) | ctx=1492ch | "To determine which trip was taken first, we n..." (263s)
  ✅ [33/60] gpt4_d9af6064 (temporal-reasoning) | 2mem 4facts 1obs | intent:[object Object] | acc=78.8% (26/33) | ctx=779ch | "To determine which device was set up first, w..." (271s)
  ❌ [34/60] gpt4_7de946e7 (temporal-reasoning) | 2mem 7facts 1obs | intent:[object Object] | acc=76.5% (26/34) | ctx=1250ch | "To determine which health issue you dealt wit..." (279s)
  ✅ [35/60] d01c6aa8 (temporal-reasoning) | 2mem 6facts 1obs | intent:[object Object] | acc=77.1% (27/35) | ctx=1081ch | "To find out how old you were when you moved t..." (286s)
  ✅ [36/60] 993da5e2 (temporal-reasoning) | 2mem 8facts 0obs | intent:[object Object] | acc=77.8% (28/36) | ctx=810ch | "To determine how long I had been using the ne..." (300s)
  ✅ [37/60] a3045048 (temporal-reasoning) | 2mem 6facts 0obs | intent:[object Object] | acc=78.4% (29/37) | ctx=11726ch | "To find out how many days before your best fr..." (307s)
  ❌ [38/60] gpt4_d31cdae3 (temporal-reasoning) | 2mem 1facts 2obs | intent:[object Object] | acc=76.3% (29/38) | ctx=12121ch | "To determine which trip the narrator took fir..." (316s)
  ❌ [39/60] gpt4_cd90e484 (temporal-reasoning) | 2mem 9facts 1obs | intent:[object Object] | acc=74.4% (29/39) | ctx=1335ch | "To determine how long you used your new binoc..." (324s)
  ✅ [40/60] gpt4_88806d6e (temporal-reasoning) | 2mem 4facts 1obs | intent:[object Object] | acc=75.0% (30/40) | ctx=13194ch | "To determine who you met first, Mark and Sara..." (331s)
  ✅ [41/60] gpt4_4cd9eba1 (temporal-reasoning) | 2mem 4facts 0obs | intent:[object Object] | acc=75.6% (31/41) | ctx=670ch | "To find out how many weeks you've been accept..." (341s)
  ✅ [42/60] gpt4_93f6379c (temporal-reasoning) | 3mem 5facts 1obs | intent:[object Object] | acc=76.2% (32/42) | ctx=768ch | "To determine which group you joined first, le..." (349s)
  ✅ [43/60] b29f3365 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=76.7% (33/43) | ctx=705ch | "To determine how long I had been taking guita..." (357s)
  ❌ [44/60] gpt4_2f56ae70 (temporal-reasoning) | 3mem 0facts 0obs | intent:[object Object] | acc=75.0% (33/44) | ctx=0ch | "I don't know...." (364s)
  ✅ [45/60] 6613b389 (temporal-reasoning) | 3mem 1facts 0obs | intent:[object Object] | acc=75.6% (34/45) | ctx=13698ch | "To find out how many months before your anniv..." (373s)
  ✅ [46/60] gpt4_78cf46a3 (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=76.1% (35/46) | ctx=11975ch | "To determine which event happened first, we n..." (379s)
  ✅ [47/60] gpt4_0a05b494 (temporal-reasoning) | 2mem 5facts 0obs | intent:[object Object] | acc=76.6% (36/47) | ctx=614ch | "To determine who you met first, we need to ca..." (387s)
  ❌ [48/60] gpt4_1a1dc16d (temporal-reasoning) | 2mem 3facts 2obs | intent:[object Object] | acc=75.0% (36/48) | ctx=714ch | "To determine which event happened first, the ..." (394s)
  ✅ [49/60] gpt4_2f584639 (temporal-reasoning) | 2mem 8facts 2obs | intent:[object Object] | acc=75.5% (37/49) | ctx=1686ch | "To determine which gift was bought first, we ..." (401s)
  ✅ [50/60] gpt4_213fd887 (temporal-reasoning) | 2mem 9facts 1obs | intent:[object Object] | acc=76.0% (38/50) | ctx=1501ch | "To determine which event you participated in ..." (409s)
  ✅ [51/60] gpt4_5438fa52 (temporal-reasoning) | 2mem 5facts 0obs | intent:[object Object] | acc=76.5% (39/51) | ctx=625ch | "To determine which event happened first, we n..." (417s)
  ✅ [52/60] gpt4_c27434e8 (temporal-reasoning) | 2mem 8facts 1obs | intent:[object Object] | acc=76.9% (40/52) | ctx=1320ch | "To determine which project was started first,..." (436s)
  ❌ [53/60] gpt4_fe651585 (temporal-reasoning) | 2mem 1facts 0obs | intent:[object Object] | acc=75.5% (40/53) | ctx=121ch | "I don't know...." (448s)
  ✅ [54/60] 8c18457d (temporal-reasoning) | 2mem 8facts 1obs | intent:[object Object] | acc=75.9% (41/54) | ctx=9433ch | "To find out how many days had passed between ..." (463s)
  ✅ [55/60] gpt4_70e84552_abs (temporal-reasoning) | 2mem 2facts 0obs | intent:[object Object] | acc=76.4% (42/55) | ctx=365ch | "I don't know. 

The context does not contain ..." (470s)
  ✅ [56/60] gpt4_93159ced_abs (temporal-reasoning) | 2mem 8facts 0obs | intent:[object Object] | acc=76.8% (43/56) | ctx=904ch | "To determine how long you've been working bef..." (478s)
  ✅ [57/60] 982b5123_abs (temporal-reasoning) | 2mem 4facts 1obs | intent:[object Object] | acc=77.2% (44/57) | ctx=866ch | "I don't know. The context does not contain in..." (485s)
  ✅ [58/60] c8090214_abs (temporal-reasoning) | 2mem 3facts 0obs | intent:[object Object] | acc=77.6% (45/58) | ctx=469ch | "To determine how many days before you bought ..." (493s)
  ✅ [59/60] gpt4_c27434e8_abs (temporal-reasoning) | 2mem 6facts 2obs | intent:[object Object] | acc=78.0% (46/59) | ctx=1205ch | "I don't know. 

The context does not mention ..." (502s)
  ✅ [60/60] gpt4_fe651585_abs (temporal-reasoning) | 2mem 1facts 0obs | intent:[object Object] | acc=78.3% (47/60) | ctx=121ch | "I don't know...." (508s)

══════════════════════════════════════════════════════
  Result: 47/60 = 78.3%
  Duration: 508s
══════════════════════════════════════════════════════
Output: /opt/HIVEMIND/benchmarks/LongMemEval/sota-output.jsonl