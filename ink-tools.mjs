export function traceHull(context, points) {
  const sorted = points.slice().sort(([ax, ay], [bx, by]) => ax - bx || ay - by);
  const side = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  function edge(sequence) {
    const result = [];
    for (const point of sequence) {
      while (result.length >= 2 && side(result.at(-2), result.at(-1), point) <= 0) result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  }
  const hull = [...edge(sorted), ...edge(sorted.reverse())];
  if (!hull.length) return;
  context.moveTo(...hull[0]);
  for (const point of hull.slice(1)) context.lineTo(...point);
  context.closePath();
}

let database;

function drafts() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('wallspace-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('copies');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Draft storage is blocked'));
  });
  return database;
}

export async function archive(data, key) {
  if (!data) return false;
  try {
    const db = await drafts();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('copies', 'readwrite');
      tx.objectStore('copies').put(data, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { return false; }
}

export async function recover(key) {
  try {
    const db = await drafts();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('copies').objectStore('copies').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}
