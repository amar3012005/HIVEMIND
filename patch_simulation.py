import re

path = '/Users/amar/HIVE-MIND/MiroFish/frontend/src/components/Step3Simulation.vue'

with open(path, 'r') as f:
    text = f.read()

# Make the edits in a similar way as the previous python script
style_block = re.search(r'<style scoped>.*', text, re.DOTALL).group(0)

new_style = style_block

# Colors
new_style = new_style.replace('background: #FFFFFF;', 'background: #ffffff;')
new_style = new_style.replace('border: 1px solid #E5E7EB;', 'border: 1px solid #e3e0db;')
new_style = new_style.replace('color: #6B7280;', 'color: #a3a3a3;')
new_style = new_style.replace('color: #9CA3AF;', 'color: #a3a3a3;')
new_style = new_style.replace('color: #111827;', 'color: #0a0a0a;')
new_style = new_style.replace('color: #4B5563;', 'color: #525252;')
new_style = new_style.replace('color: #374151;', 'color: #525252;')
new_style = new_style.replace('background: #F9FAFB;', 'background: #faf9f4;')
new_style = new_style.replace('background: #F3F4F6;', 'background: #f3f1ec;')
new_style = new_style.replace('background: linear-gradient(135deg, #f8f9fa 0%, #f1f3f4 100%);', 'background: #faf9f4;')
new_style = new_style.replace('background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);', 'background: #ffffff;')
new_style = new_style.replace('background: linear-gradient(180deg, #FDFBFE 0%, #FFFFFF 100%);', 'background: #faf9f4;')
new_style = new_style.replace('background: linear-gradient(90deg, #f7f0fa 0%, #ffffff 100%);', 'background: linear-gradient(90deg, #faf9f4 0%, #ffffff 100%);')
new_style = new_style.replace('background: linear-gradient(90deg, #fff0f0 0%, #ffffff 100%);', 'background: linear-gradient(90deg, #faf9f4 0%, #ffffff 100%);')
new_style = new_style.replace('border-bottom: 1px solid #E2E8F0;', 'border-bottom: 1px solid #e3e0db;')
new_style = new_style.replace('border-top: 1px solid #E2E8F0;', 'border-top: 1px solid #e3e0db;')
new_style = new_style.replace('background: #F8FAFC;', 'background: #faf9f4;')
new_style = new_style.replace('background: #F1F5F9;', 'background: #f3f1ec;')
new_style = new_style.replace('color: #0F172A;', 'color: #0a0a0a;')
new_style = new_style.replace('color: #334155;', 'color: #525252;')
new_style = new_style.replace('color: #475569;', 'color: #525252;')
new_style = new_style.replace('color: #64748B;', 'color: #a3a3a3;')
new_style = new_style.replace('color: #94A3B8;', 'color: #a3a3a3;')
new_style = new_style.replace('border: 1px solid #CBD5E1;', 'border: 1px solid #e3e0db;')

# Interaction colors
new_style = new_style.replace('background: #7B2D8E;', 'background: #117dff;')
new_style = new_style.replace('color: #7B2D8E;', 'color: #117dff;')
new_style = new_style.replace('border-color: #7B2D8E;', 'border-color: #117dff;')
new_style = new_style.replace('border-top: 2px solid #7B2D8E;', 'border-top: 2px solid #117dff;')
new_style = new_style.replace('border-left: 3px solid #7B2D8E;', 'border-left: 3px solid #117dff;')
new_style = new_style.replace('border-color: #A052B3;', 'border-color: #117dff;')
new_style = new_style.replace('color: #A052B3;', 'color: #117dff;')

new_style = new_style.replace('background: #E34A4A;', 'background: #16a34a;')
new_style = new_style.replace('color: #E34A4A;', 'color: #16a34a;')
new_style = new_style.replace('border-left: 3px solid #E34A4A;', 'border-left: 3px solid #16a34a;')

# Fonts
new_style = new_style.replace('font-family: \'Inter\', -apple-system, sans-serif;', 'font-family: \'Space Grotesk\', sans-serif;')
new_style = new_style.replace('font-family: \'Inter\', sans-serif;', 'font-family: \'Space Grotesk\', sans-serif;')

text = text.replace(style_block, new_style)

with open(path, 'w') as f:
    f.write(text)

