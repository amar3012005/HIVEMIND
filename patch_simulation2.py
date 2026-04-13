import re

file_path = "/Users/amar/HIVE-MIND/MiroFish/frontend/src/components/Step3Simulation.vue"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# Replace shorthand HEX and uncoordinated aesthetics
text = re.sub(r'background:\s*#FFF\b', 'background: #ffffff', text, flags=re.IGNORECASE)
text = re.sub(r'background-color:\s*#FFF\b', 'background-color: #ffffff', text, flags=re.IGNORECASE)
text = re.sub(r'border:\s*1px\s*solid\s*#EAEAEA', 'border: 1px solid #e5e5e5', text, flags=re.IGNORECASE)
text = re.sub(r'border-bottom:\s*1px\s*solid\s*#EAEAEA', 'border-bottom: 1px solid #e5e5e5', text, flags=re.IGNORECASE)
text = re.sub(r'border-top:\s*1px\s*solid\s*#EAEAEA', 'border-top: 1px solid #e5e5e5', text, flags=re.IGNORECASE)

# Tweak component specific accents to the 117dff / MemoryGraph palette 
# (assuming Twitter logo colour & active states were black)
text = re.sub(r'\.platform-status\.twitter \.platform-icon \{ color: #[0-9a-fA-F]+; \}', '.platform-status.twitter .platform-icon { color: #117dff; }', text)
text = re.sub(r'\.breakdown-item\.twitter \{ color: #[0-9a-fA-F]+; \}', '.breakdown-item.twitter { color: #117dff; }', text)
text = re.sub(r'\.timeline-item\.twitter \.marker-dot \{ background: #[0-9a-fA-F]+; \}', '.timeline-item.twitter .marker-dot { background: #117dff; }', text)
text = re.sub(r'\.timeline-item\.twitter \.timeline-marker \{ border-color: #[0-9a-fA-F]+; \}', '.timeline-item.twitter .timeline-marker { border-color: #117dff; }', text)


with open(file_path, "w", encoding="utf-8") as f:
    f.write(text)

print("Second pass executed.")
