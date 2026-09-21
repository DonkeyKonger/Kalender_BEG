import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';

const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const component=source.slice(source.indexOf('function MobileProjectPhotoCapture('),source.indexOf('function MobileProjectPhotosPanel('));
const compiled=await build({stdin:{contents:`
  export function flow({uploading=false,open=true,connected=true,fail=false}={}) {
    const events=[];let stateIndex=0,refIndex=0;
    const useState=initial=>{const i=stateIndex++;return [i===0?uploading:i===3?open:initial,value=>events.push(['state',i,value])];};
    const useRef=()=>{const name=refIndex++===0?'camera':'library';return {current:{click:()=>events.push([name])}};};
    const MobileOverviewPhotoAction=()=>null,ExtraWorkPhotoSourceDialog=()=>null;
    class ApiError extends Error {}
    const readApiError=(_error,fallback)=>fallback;
    const prepareMeasurementPhotoFile=async file=>{events.push(['prepare',file]);return file;};
    const api={projectFolders:async()=>connected?[{folder_key:'fotos',external_drive_id:'drive',external_item_id:'folder'}]:[],
      uploadProjectFolderDocument:async(...args)=>{if(fail)throw new ApiError('failed');events.push(['upload',...args]);}};
    ${component}
    return {events,tree:MobileProjectPhotoCapture({assignment:{site:{id:42}},onOpenPhotos:()=>events.push(['photos'])})};
  }
`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const controls=flow=>flow.tree.props.children;

test('project camera button opens chooser first; cancel opens no file picker',()=>{
  const flow=module.exports.flow();controls(flow)[1].props.onTakePhoto();
  assert.deepEqual(flow.events,[['state',1,null],['state',2,'info'],['state',3,true]]);
  flow.events.length=0;controls(flow)[2].props.onClose();
  assert.deepEqual(flow.events,[['state',3,false]]);
  controls(flow)[1].props.onOpenPhotos();
  assert.deepEqual(flow.events.at(-1),['photos']);
  assert.equal(controls(module.exports.flow({open:false}))[2],null);
});

test('both sources close chooser then open the matching single-image input',()=>{
  for(const [handler,picker] of [['onTakePhoto','camera'],['onChoosePhoto','library']]) {
    const flow=module.exports.flow();controls(flow)[2].props[handler]();
    assert.deepEqual(flow.events,[['state',3,false],[picker]]);
  }
  const [, , ,camera,library]=controls(module.exports.flow());
  assert.equal(camera.props.capture,'environment');assert.equal(library.props.capture,undefined);
  for(const input of [camera,library]) {assert.equal(input.props.accept,'image/*');assert.equal(input.props.multiple,undefined);}
});

test('both inputs preserve project folder validation, preparation, upload and error handling',async()=>{
  for(const index of [3,4]) {
    const flow=module.exports.flow();const file={name:'photo.jpg'};const event={target:{files:[file],value:'photo.jpg'}};
    controls(flow)[index].props.onChange(event);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(event.target.value,'');
    assert.ok(flow.events.some(e=>e[0]==='prepare'&&e[1]===file));
    assert.ok(flow.events.some(e=>e[0]==='upload'&&e[1]===42&&e[2]==='fotos'&&e[3]===file));
    assert.ok(flow.events.some(e=>e[2]==='Foto gespeichert.'));
    assert.deepEqual(flow.events.at(-1),['state',0,false]);
  }
  for(const options of [{connected:false},{fail:true}]) {
    const flow=module.exports.flow(options);
    controls(flow)[4].props.onChange({target:{files:[{}],value:'photo'}});await new Promise(resolve=>setImmediate(resolve));
    assert.ok(flow.events.some(e=>e[1]===2&&e[2]==='error'));
    assert.ok(!flow.events.some(e=>e[0]==='upload'));
    assert.deepEqual(flow.events.at(-1),['state',0,false]);
  }
});

test('cancelled selections and upload-in-progress trigger no new upload or picker',async()=>{
  const busy=module.exports.flow({uploading:true});
  assert.equal(controls(busy)[1].props.disabled,true);
  controls(busy)[1].props.onTakePhoto();controls(busy)[2].props.onTakePhoto();controls(busy)[2].props.onChoosePhoto();
  controls(busy)[3].props.onChange({target:{files:[{}],value:'photo'}});
  const cancelled=module.exports.flow();controls(cancelled)[4].props.onChange({target:{files:[],value:''}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(busy.events,[]);assert.deepEqual(cancelled.events,[]);
});
