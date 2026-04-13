import re

file_path = "/Users/amar/HIVE-MIND/MiroFish/frontend/src/components/Step2EnvSetup.vue"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# Make .mode-chip.active beautiful blue
text = re.sub(r'border-color:\s*#111;', 'border-color: #117dff;', text, flags=re.IGNORECASE)
text = re.sub(r'background:\s*#111;', 'background: #117dff;', text, flags=re.IGNORECASE)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(text)

