import re

file_path = "/Users/amar/HIVE-MIND/MiroFish/frontend/src/components/Step2EnvSetup.vue"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# Replace major background and border colors
text = re.sub(r'(background(-color)?:\s*)#[fF]{3}\b', r'\1#ffffff', text)
text = re.sub(r'(background(-color)?:\s*)#[fF]{6}\b', r'\1#ffffff', text)
text = re.sub(r'(background(-color)?:\s*)#FAFAFA\b', r'\1#faf9f4', text, flags=re.IGNORECASE)
text = re.sub(r'#EAEAEA\b', '#e5e5e5', text, flags=re.IGNORECASE)

# Update font family if any other fallback is present to strictly prioritize Space Grotesk
text = re.sub(r"font-family:\s*[^;]*;", "font-family: 'Space Grotesk', system-ui, sans-serif;", text)

# Write back
with open(file_path, "w", encoding="utf-8") as f:
    f.write(text)

print("Pushed theme aesthetic to Step2EnvSetup.vue")
