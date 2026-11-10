// Minimal ZIP writer (deflate, no external dependencies).
import {deflateRawSync,crc32} from 'node:zlib';
export function zip(entries){
  const parts=[],central=[];let offset=0;
  const dos=d=>{const t=((d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1))&0xffff;const day=(((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate())&0xffff;return [t,day];};
  const [time,date]=dos(new Date());
  for(const {name,data} of entries){
    const nameBuf=Buffer.from(name,'utf8');const raw=Buffer.isBuffer(data)?data:Buffer.from(String(data),'utf8');
    const comp=deflateRawSync(raw);const crc=crc32(raw)>>>0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(8,8);
    local.writeUInt16LE(time,10);local.writeUInt16LE(date,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(comp.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(nameBuf.length,26);
    parts.push(local,nameBuf,comp);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(8,10);
    c.writeUInt16LE(time,12);c.writeUInt16LE(date,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(comp.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(nameBuf.length,28);c.writeUInt32LE(offset,42);
    central.push(c,nameBuf);offset+=30+nameBuf.length+comp.length;
  }
  const cd=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,cd,end]);
}
