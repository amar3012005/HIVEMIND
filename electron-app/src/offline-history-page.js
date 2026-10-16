const rooms = document.getElementById('rooms'), content = document.getElementById('conversation');
const text = (tag, value) => { const element = document.createElement(tag); element.textContent = value; return element; };
async function load() {
  const data = await window.offlineHistory.list(); rooms.replaceChildren();
  document.getElementById('company').textContent = data.company ? `${data.company} · Encrypted on this Mac` : 'No unlocked offline copies for this account';
  if (!data.rooms.length) rooms.append(text('p', 'Open a conversation while signed in to save its loaded messages. Copies lock after 24 hours without account verification.'));
  for (const room of data.rooms) {
    const button = document.createElement('button'); button.append(text('span', room.title), text('small', `${room.provider} · ${room.count} messages`));
    button.onclick = async () => {
      const saved = await window.offlineHistory.read(room.id); if (!saved) { await load(); return; }
      for (const item of rooms.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
      content.replaceChildren(text('h2', saved.title), text('p', `Read-only copy · Saved ${new Date(saved.savedAt).toLocaleString()} · Loaded messages only`));
      for (const message of saved.messages) {
        const section = document.createElement('section'); section.className = message.role;
        section.append(text('strong', message.role === 'user' ? 'You' : message.role === 'team' ? 'Team message' : 'Employee'), text('div', message.text)); content.append(section);
      }
    };
    rooms.append(button);
  }
}
document.getElementById('reconnect').onclick = () => window.offlineHistory.reconnect();
document.getElementById('clear').onclick = async () => { await window.offlineHistory.clear(); content.replaceChildren(text('p', 'Offline copies cleared. Reconnect to resume saving.')); await load(); };
load().catch(() => { document.getElementById('status').textContent = 'Offline history is unavailable. Return to the live app.'; });
