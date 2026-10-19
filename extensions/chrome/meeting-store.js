/* Audio is retained locally until the authenticated server acknowledges it. */
(function(root){
 const opened=new Promise((resolve,reject)=>{const r=indexedDB.open('hivemind-meeting-audio',1);r.onupgradeneeded=()=>{r.result.createObjectStore('audio',{keyPath:'key'});r.result.createObjectStore('sessions',{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
 async function run(store,mode,fn){const db=await opened;return new Promise((resolve,reject)=>{const tx=db.transaction(store,mode);let result;try{const req=fn(tx.objectStore(store));req.onsuccess=()=>{result=req.result}}catch(e){reject(e);return}tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||new Error('Local recording storage failed'));tx.onerror=()=>reject(tx.error)})}
 root.HMMeetingStore={put:(store,value)=>run(store,'readwrite',s=>s.put(value)),remove:(store,key)=>run(store,'readwrite',s=>s.delete(key)),all:store=>run(store,'readonly',s=>s.getAll())};
})(globalThis);
