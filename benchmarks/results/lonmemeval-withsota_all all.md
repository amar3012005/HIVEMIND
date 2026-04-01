root@Blaiq-Amar-Dev:/opt/HIVEMIND# cd /opt/HIVEMIND && \
HIVEMIND_API_KEY="hmk_live_REDACTED" \
HIVEMIND_API_BASE="https://core.hivemind.davinciai.eu:8050" \
GROQ_API_KEY="gsk_REDACTED" \
GEN_MODEL="llama-3.3-70b-versatile" \
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

(node:1688216) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
(Use `node --trace-warnings ...` to show where the warning was created)
Memories cleaned.

  ❌ [1/60] gpt4_2655b836 (temporal-reasoning) | 3mem 4facts 1obs | intent:[object Object] | acc=0.0% (0/1) | ctx=490ch | "I don't know. The provided context does not c..." (8s)
  ❌ [2/60] gpt4_2487a7cb (temporal-reasoning) | 2mem 1facts 1obs | intent:[object Object] | acc=0.0% (0/2) | ctx=293ch | "I don't know. The provided context does not c..." (13s)
  ✅ [3/60] gpt4_76048e76 (temporal-reasoning) | 2mem 5facts 2obs | intent:[object Object] | acc=33.3% (1/3) | ctx=969ch | "To determine which vehicle was taken care of ..." (22s)
  ✅ [4/60] gpt4_2312f94c (temporal-reasoning) | 2mem 4facts 1obs | intent:[object Object] | acc=50.0% (2/4) | ctx=13054ch | "To determine which device you got first, let'..." (29s)
  ✅ [5/60] 0bb5a684 (temporal-reasoning) | 2mem 4facts 2obs | intent:[object Object] | acc=60.0% (3/5) | ctx=939ch | "To find out how many days before the team mee..." (35s)
  ✅ [6/60] 08f4fc43 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=66.7% (4/6) | ctx=693ch | "To find out how many days had passed between ..." (41s)
  ✅ [7/60] 2c63a862 (temporal-reasoning) | 2mem 5facts 0obs | intent:[object Object] | acc=71.4% (5/7) | ctx=13932ch | "To find the answer, let's look at the Key Fac..." (48s)
  ❌ [8/60] gpt4_385a5000 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=62.5% (5/8) | ctx=13382ch | "The marigold seeds were started on March 3rd,..." (54s)
  ✅ [9/60] 2a1811e2 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=66.7% (6/9) | ctx=13040ch | "To find out how many days had passed between ..." (60s)
  ✅ [10/60] bbf86515 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=70.0% (7/10) | ctx=13630ch | "To find out how many days before the 'Rack Fe..." (67s)
  ❌ [11/60] gpt4_5dcc0aab (temporal-reasoning) | 5mem 0facts 0obs | intent:[object Object] | acc=63.6% (7/11) | ctx=0ch | "I don't know...." (76s)
  ❌ [12/60] gpt4_0b2f1d21 (temporal-reasoning) | 2mem 0facts 2obs | intent:[object Object] | acc=58.3% (7/12) | ctx=326ch | "The context does not provide specific dates f..." (82s)
  ✅ [13/60] f0853d11 (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=61.5% (8/13) | ctx=475ch | "To find out how many days had passed between ..." (89s)
  ❌ [14/60] gpt4_6ed717ea (temporal-reasoning) | 2mem 3facts 2obs | intent:[object Object] | acc=57.1% (8/14) | ctx=672ch | "Based on the provided context, I don't know w..." (97s)
  ✅ [15/60] gpt4_70e84552 (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=60.0% (9/15) | ctx=496ch | "To determine which task was completed first, ..." (103s)
  ✅ [16/60] a3838d2b (temporal-reasoning) | 6mem 7facts 3obs | intent:[object Object] | acc=62.5% (10/16) | ctx=1511ch | "To determine how many charity events you part..." (113s)
  ❌ [17/60] gpt4_93159ced (temporal-reasoning) | 2mem 1facts 1obs | intent:[object Object] | acc=58.8% (10/17) | ctx=271ch | "I don't know. The provided context does not c..." (119s)
  ✅ [18/60] gpt4_2d58bcd6 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=61.1% (11/18) | ctx=754ch | "Based on the provided context, 'The Hate U Gi..." (126s)
  ❌ [19/60] gpt4_65aabe59 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=57.9% (11/19) | ctx=631ch | "The context does not contain enough informati..." (132s)
  ❌ [20/60] 982b5123 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=55.0% (11/20) | ctx=541ch | "To determine how many months ago the Airbnb i..." (138s)
  ✅ [21/60] b9cfe692 (temporal-reasoning) | 3mem 4facts 1obs | intent:[object Object] | acc=57.1% (12/21) | ctx=11476ch | "To find out how long it took to finish 'The S..." (146s)
  ✅ [22/60] gpt4_4edbafa2 (temporal-reasoning) | 2mem 4facts 1obs | intent:[object Object] | acc=59.1% (13/22) | ctx=719ch | "The date on which you attended the first BBQ ..." (152s)
  ✅ [23/60] c8090214 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=60.9% (14/23) | ctx=13316ch | "To determine how many days before you bought ..." (159s)
  ❌ [24/60] gpt4_483dd43c (temporal-reasoning) | 2mem 4facts 2obs | intent:[object Object] | acc=58.3% (14/24) | ctx=760ch | "To determine which show you started watching ..." (165s)
  ✅ [25/60] e4e14d04 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=60.0% (15/25) | ctx=645ch | "To determine how long you had been a member o..." (170s)
  ✅ [26/60] c9f37c46 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=61.5% (16/26) | ctx=667ch | "To determine how long you had been watching s..." (177s)
  ❌ [27/60] gpt4_2c50253f (temporal-reasoning) | 2mem 1facts 0obs | intent:[object Object] | acc=59.3% (16/27) | ctx=185ch | "I don't know...." (184s)
  ✅ [28/60] dcfa8644 (temporal-reasoning) | 2mem 3facts 0obs | intent:[object Object] | acc=60.7% (17/28) | ctx=13590ch | "To find out how many days had passed since yo..." (190s)
  ❌ [29/60] gpt4_b4a80587 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=58.6% (17/29) | ctx=563ch | "To determine which event happened first, let'..." (196s)
  ❌ [30/60] gpt4_9a159967 (temporal-reasoning) | 3mem 6facts 1obs | intent:[object Object] | acc=56.7% (17/30) | ctx=9560ch | "Based on the provided context, the airline yo..." (205s)
  ✅ [31/60] cc6d1ec1 (temporal-reasoning) | 2mem 3facts 2obs | intent:[object Object] | acc=58.1% (18/31) | ctx=557ch | "You had been bird watching for about 2 months..." (210s)
  ✅ [32/60] gpt4_8c8961ae (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=59.4% (19/32) | ctx=612ch | "To determine which trip you took first, let's..." (217s)
  ✅ [33/60] gpt4_d9af6064 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=60.6% (20/33) | ctx=538ch | "You set up the new router first, on January 1..." (223s)
  ✅ [34/60] gpt4_7de946e7 (temporal-reasoning) | 2mem 4facts 2obs | intent:[object Object] | acc=61.8% (21/34) | ctx=932ch | "Based on the provided context, you dealt with..." (229s)
  ✅ [35/60] d01c6aa8 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=62.9% (22/35) | ctx=650ch | "To find out how old you were when you moved t..." (235s)
  ✅ [36/60] 993da5e2 (temporal-reasoning) | 2mem 7facts 0obs | intent:[object Object] | acc=63.9% (23/36) | ctx=13898ch | "To determine how long you had been using the ..." (245s)
  ✅ [37/60] a3045048 (temporal-reasoning) | 2mem 3facts 0obs | intent:[object Object] | acc=64.9% (24/37) | ctx=11522ch | "To determine how many days before your best f..." (253s)
  ✅ [38/60] gpt4_d31cdae3 (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=65.8% (25/38) | ctx=11975ch | "The narrator took the family road trip across..." (260s)
  ❌ [39/60] gpt4_cd90e484 (temporal-reasoning) | 2mem 5facts 1obs | intent:[object Object] | acc=64.1% (25/39) | ctx=13621ch | "To determine how long you used your new binoc..." (270s)
  ✅ [40/60] gpt4_88806d6e (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=65.0% (26/40) | ctx=13761ch | "To answer the question "Who did I meet first,..." (276s)
  ✅ [41/60] gpt4_4cd9eba1 (temporal-reasoning) | 2mem 4facts 1obs | intent:[object Object] | acc=65.9% (27/41) | ctx=820ch | "To determine how many weeks you've been accep..." (283s)
  ✅ [42/60] gpt4_93f6379c (temporal-reasoning) | 3mem 4facts 2obs | intent:[object Object] | acc=66.7% (28/42) | ctx=835ch | "You joined 'Page Turners' first, as you joine..." (290s)
  ✅ [43/60] b29f3365 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=67.4% (29/43) | ctx=638ch | "To determine how long you had been taking gui..." (296s)
  ❌ [44/60] gpt4_2f56ae70 (temporal-reasoning) | 3mem 0facts 0obs | intent:[object Object] | acc=65.9% (29/44) | ctx=0ch | "I don't know...." (304s)
  ✅ [45/60] 6613b389 (temporal-reasoning) | 3mem 1facts 0obs | intent:[object Object] | acc=66.7% (30/45) | ctx=13555ch | "To determine how many months before your anni..." (311s)
  ✅ [46/60] gpt4_78cf46a3 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=67.4% (31/46) | ctx=11899ch | "To determine which event happened first, we n..." (318s)
  ❌ [47/60] gpt4_0a05b494 (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=66.0% (31/47) | ctx=360ch | "I don't know. The provided context does not c..." (324s)
  ❌ [48/60] gpt4_1a1dc16d (temporal-reasoning) | 2mem 1facts 2obs | intent:[object Object] | acc=64.6% (31/48) | ctx=542ch | "The pride parade happened first. It occurred ..." (330s)
  ❌ [49/60] gpt4_2f584639 (temporal-reasoning) | 2mem 3facts 1obs | intent:[object Object] | acc=63.3% (31/49) | ctx=11111ch | "You bought the necklace for your sister first..." (336s)
  ✅ [50/60] gpt4_213fd887 (temporal-reasoning) | 2mem 3facts 2obs | intent:[object Object] | acc=64.0% (32/50) | ctx=680ch | "Based on the provided context, you participat..." (342s)
  ❌ [51/60] gpt4_5438fa52 (temporal-reasoning) | 2mem 5facts 0obs | intent:[object Object] | acc=62.7% (32/51) | ctx=650ch | "To determine which event happened first, let'..." (348s)
  ✅ [52/60] gpt4_c27434e8 (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=63.5% (33/52) | ctx=774ch | "To determine which project was started first,..." (356s)
  ❌ [53/60] gpt4_fe651585 (temporal-reasoning) | 2mem 1facts 0obs | intent:[object Object] | acc=62.3% (33/53) | ctx=121ch | "I don't know...." (362s)
  ❌ [54/60] 8c18457d (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=61.1% (33/54) | ctx=8335ch | "To find out how many days had passed between ..." (368s)
  ✅ [55/60] gpt4_70e84552_abs (temporal-reasoning) | 2mem 2facts 0obs | intent:[object Object] | acc=61.8% (34/55) | ctx=364ch | "I don't know. The provided context does not c..." (374s)
  ✅ [56/60] gpt4_93159ced_abs (temporal-reasoning) | 2mem 2facts 0obs | intent:[object Object] | acc=62.5% (35/56) | ctx=285ch | "I don't know...." (379s)
  ✅ [57/60] 982b5123_abs (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=63.2% (36/57) | ctx=13775ch | "I don't know...." (389s)
  ✅ [58/60] c8090214_abs (temporal-reasoning) | 2mem 2facts 1obs | intent:[object Object] | acc=63.8% (37/58) | ctx=569ch | "To answer the question, we need to determine ..." (394s)
  ✅ [59/60] gpt4_c27434e8_abs (temporal-reasoning) | 2mem 2facts 2obs | intent:[object Object] | acc=64.4% (38/59) | ctx=774ch | "I don't know. The context does not mention wh..." (399s)
  ❌ [60/60] gpt4_fe651585_abs (temporal-reasoning) | 2mem 2facts 0obs | intent:[object Object] | acc=63.3% (38/60) | ctx=251ch | "Alex became a parent first. The context state..." (405s)

══════════════════════════════════════════════════════
  Result: 38/60 = 63.3%
  Duration: 405s
══════════════════════════════════════════════════════
Output: /opt/HIVEMIND/benchmarks/LongMemEval/sota-output.jsonl

By type:
  temporal-reasoning: 38/60 = 63.3%
root@Blaiq-Amar-Dev:/opt/HIVEMIND# 