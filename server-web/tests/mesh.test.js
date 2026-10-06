import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = (await readFile(new URL('../client/src/rtc/MeshRoom.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const {MeshRoom} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
class Stream {
  constructor(){this.tracks=[];}
  getTracks(){return this.tracks;}
  getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}
  getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}
  addTrack(t){this.tracks.push(t);}
  removeTrack(t){this.tracks=this.tracks.filter(x=>x!==t);}
}
class PC {
  constructor(){this.connectionState='new';this.signalingState='stable';this.slots=[];}
  addTransceiver(track){const slot={sender:{track,async replaceTrack(t){this.track=t;}}};this.slots.push(slot);return slot;}
  close(){this.connectionState='closed';this.signalingState='closed';}
}
test('mesh maintains four independent connections, fans tracks out, preserves remaining calls on departure',async()=>{
 const errors=[];
 const room=new MeshRoom({onChange(){},onError:e=>errors.push(e)},{RTCPeerConnection:PC,MediaStream:Stream});
 room.socket={id:'a',connected:true,emit(){},disconnect(){this.connected=false;}};
 room.rtcConfig={iceServers:[]};room.local=new Stream();
 room.local.addTrack({id:'audio',kind:'audio',stop(){}});
 const members=['a','b','c','d','e'].map(id=>({id,name:id,consent:true}));
 room.syncPeers(members);
 assert.equal(room.links.size,4);assert.equal(room.state.participants.length,4);
 assert.equal(new Set([...room.links.values()].map(p=>p.pc)).size,4);
 const track={id:'camera',kind:'video'};
 await room.replaceAll('cameraSender',track);
 for(const p of room.links.values())assert.equal(p.cameraSender.track,track);
 const old=room.links.get('b'),survivor=room.links.get('c');
 room.syncPeers(members.filter(m=>m.id!=='b'));
 assert.equal(old.pc.connectionState,'closed');assert.equal(room.links.get('c'),survivor);
 room.syncPeers([...members.filter(m=>m.id!=='b'),{id:'f',name:'new',consent:true}]);
 assert.equal(room.links.size,4);
 room.socket.connected=false;room.update({status:'Reconnecting to server'});room.publishParticipants();
 assert.equal(room.state.status,'Reconnecting to server');
 room.leave();assert.equal(room.links.size,0);assert.equal(room.disposed,true);assert.deepEqual(errors,[]);
});
