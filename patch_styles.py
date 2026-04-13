import re

with open('/Users/amar/HIVE-MIND/MiroFish/frontend/src/components/HistoryDatabase.vue', 'r') as f:
    text = f.read()

# Replace colours and fonts
style_block = re.search(r'<style scoped>.*', text, re.DOTALL).group(0)

new_style = style_block
new_style = new_style.replace('background: #FFFFFF;', 'background: #ffffff;')
new_style = new_style.replace('border: 1px solid #E5E7EB;', 'border: 1px solid #e3e0db;')
new_style = new_style.replace('color: #6B7280;', 'color: #525252;')
new_style = new_style.replace('color: #9CA3AF;', 'color: #a3a3a3;')
new_style = new_style.replace('color: #111827;', 'color: #0a0a0a;')
new_style = new_style.replace('color: #4B5563;', 'color: #525252;')
new_style = new_style.replace('color: #374151;', 'color: #525252;')
new_style = new_style.replace('background: #F9FAFB;', 'background: #faf9f4;')
new_style = new_style.replace('background: #F3F4F6;', 'background: #f3f1ec;')
new_style = new_style.replace('border-color: rgba(0, 0, 0, 0.4);', 'border-color: #117dff;')
new_style = new_style.replace('background: linear-gradient(135deg, #f8f9fa 0%, #f1f3f4 100%);', 'background: #faf9f4;')
new_style = new_style.replace('background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);', 'background: #ffffff;')
new_style = new_style.replace('border: 1px solid #e8eaed;', 'border: 1px solid #e3e0db;')
new_style = new_style.replace('font-family: \'Inter\', -apple-system, sans-serif;', 'font-family: \'Space Grotesk\', sans-serif;')
new_style = new_style.replace('font-family: \'Inter\', sans-serif;', 'font-family: \'Space Grotesk\', sans-serif;')

text = text.replace(style_block, new_style)

with open('/Users/amar/HIVE-MIND/MiroFish/frontend/src/components/HistoryDatabase.vue', 'w') as f:
    f.write(text)

