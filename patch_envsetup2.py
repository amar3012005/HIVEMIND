import re

file_path = "/Users/amar/HIVE-MIND/MiroFish/frontend/src/components/Step2EnvSetup.vue"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# Replace hard black text with soft dark 0a0a0a or 525252
text = re.sub(r'color:\s*#000', 'color: #0a0a0a', text, flags=re.IGNORECASE)
text = re.sub(r'color:\s*#333', 'color: #525252', text, flags=re.IGNORECASE)
text = re.sub(r'color:\s*#666', 'color: #737373', text, flags=re.IGNORECASE)

# Badges (like "WAITING" or "INITIALIZING")
# Usually have background variants. Let's make them softer.
text = re.sub(r'#FF5722', '#117dff', text, flags=re.IGNORECASE) # Orange to blue
text = re.sub(r'#000000', '#0a0a0a', text, flags=re.IGNORECASE) # Pure black backgrounds -> soft black

# Borders
text = re.sub(r'border-color:\s*#EEE', 'border-color: #e5e5e5', text, flags=re.IGNORECASE)
text = re.sub(r'border:\s*1px\s*solid\s*#EEE', 'border: 1px solid #e5e5e5', text, flags=re.IGNORECASE)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(text)

