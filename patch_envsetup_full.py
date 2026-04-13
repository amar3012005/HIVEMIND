import re

file_path = "/Users/amar/HIVE-MIND/MiroFish/frontend/src/components/Step2EnvSetup.vue"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# Soft backgrounds
text = re.sub(r'#FAFAFA\b', '#faf9f4', text, flags=re.IGNORECASE)
text = re.sub(r'#F5F5F5\b', '#f4f4f5', text, flags=re.IGNORECASE)
text = re.sub(r'#FCFCFC\b', '#faf9f4', text, flags=re.IGNORECASE)

# Borders
text = re.sub(r'#EAEAEA\b', '#e5e5e5', text, flags=re.IGNORECASE)
text = re.sub(r'#EEE\b', '#e5e5e5', text, flags=re.IGNORECASE)
text = re.sub(r'#DDD\b', '#d4d4d8', text, flags=re.IGNORECASE)

# Text Colors
text = re.sub(r'#000000\b', '#0a0a0a', text, flags=re.IGNORECASE)
text = re.sub(r'color:\s*#000\b', 'color: #0a0a0a', text, flags=re.IGNORECASE)
text = re.sub(r'#333\b', '#525252', text, flags=re.IGNORECASE)
text = re.sub(r'#555\b', '#737373', text, flags=re.IGNORECASE)
text = re.sub(r'#666\b', '#737373', text, flags=re.IGNORECASE)
text = re.sub(r'#999\b', '#a1a1aa', text, flags=re.IGNORECASE)

# Badges and primary buttons
text = re.sub(r'background:\s*#0a0a0a;\s*color:\s*#FFF', 'background: #117dff; color: #ffffff', text, flags=re.IGNORECASE) # button primary
text = re.sub(r'background:\s*#000;\s*color:\s*#FFF', 'background: #117dff; color: #ffffff', text, flags=re.IGNORECASE) # button primary fix
text = re.sub(r'\.badge\.processing\s*{[^}]*}', '.badge.processing { background: #d97706; color: #ffffff; border-radius: 4px; padding: 4px 8px; font-weight: 500; font-size: 11px; }', text, flags=re.IGNORECASE)
text = re.sub(r'\.badge\.pending\s*{[^}]*}', '.badge.pending { background: #f4f4f5; color: #737373; border-radius: 4px; padding: 4px 8px; font-weight: 500; font-size: 11px; }', text, flags=re.IGNORECASE)
text = re.sub(r'\.badge\.success\s*{[^}]*}', '.badge.success { background: #16a34a; color: #ffffff; border-radius: 4px; padding: 4px 8px; font-weight: 500; font-size: 11px; }', text, flags=re.IGNORECASE)

text = re.sub(r'border-radius:\s*2px', 'border-radius: 6px', text, flags=re.IGNORECASE)
text = re.sub(r'border-radius:\s*4px', 'border-radius: 6px', text, flags=re.IGNORECASE)
text = re.sub(r'border-radius:\s*8px', 'border-radius: 12px', text, flags=re.IGNORECASE)

text = re.sub(r'font-family:\s*[^;]*;', "font-family: 'Space Grotesk', system-ui, sans-serif;", text)

# Pure whites
text = re.sub(r'#FFF\b', '#ffffff', text, flags=re.IGNORECASE)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(text)

