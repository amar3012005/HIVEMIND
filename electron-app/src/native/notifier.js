'use strict';
// Native notifications for bell items. Click focuses the window and hands the renderer an
// in-app path (validated), never a URL.
const policy = require('./policy');

function createNotifier({ Notification, onClick }) {
  const live = new Set(); // keep references so notifications are not garbage collected before click
  return {
    show({ id, title, body, path } = {}) {
      if (typeof title !== 'string' || !title || title.length > 120) throw new Error('title');
      if (body != null && (typeof body !== 'string' || body.length > 400)) throw new Error('body');
      if (!Notification.isSupported()) return { shown: false };
      const target = path == null ? null : policy.safeAppPath(path);
      if (path != null && !target) throw new Error('path');
      const n = new Notification({ title, body: body || '', silent: false });
      live.add(n);
      n.on('click', () => onClick(target, typeof id === 'string' ? id.slice(0, 80) : null));
      n.on('close', () => live.delete(n));
      n.show();
      return { shown: true };
    },
  };
}

module.exports = { createNotifier };
