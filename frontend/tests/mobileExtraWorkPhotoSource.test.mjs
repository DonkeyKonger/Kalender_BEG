import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const tab=source.slice(source.indexOf('function MobileExtraWorkTab('),source.indexOf('function ExtraWorkOrderOverview('));
const helpers=tab.slice(tab.indexOf('  function openPhotoInput('),tab.indexOf('  async function handlePhotoInputChange('));
const overview=tab.slice(tab.indexOf('<ExtraWorkOrderOverview'));
const controls=overview.slice(overview.indexOf('{isPhotoSourceDialogOpen ?'),overview.indexOf('      </>'));
const compiled=await build({stdin:{contents:`
  export function flow({uploading=false,count=0,open=true}={}) {
    const events=[];
    const isUploadingPhoto=uploading,isPhotoSourceDialogOpen=open,MOBILE_DOCUMENT_PHOTO_LIMIT=5;
    const selectedOrder={id:24,photo_count:count};
    const setPhotoUploadOrder=value=>events.push(['target',value.id]);
    const setMessage=value=>events.push(['message',value]);
    const setPhotoMessageTone=value=>events.push(['tone',value]);
    const setIsPhotoSourceDialogOpen=value=>events.push(['dialog',value]);
    const photoInputRef={current:{click:()=>events.push(['camera'])}};
    const photoLibraryInputRef={current:{click:()=>events.push(['library'])}};
    const handlePhotoInputChange=event=>events.push(['upload',event]);
    const ExtraWorkPhotoSourceDialog=()=>null;
    ${helpers}
    return {events,request:()=>openPhotoSourceSelection(selectedOrder),controls:<>${controls}</>};
  }`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);

test('overview photo action opens source selection without starting either file picker',()=>{
  const flow=module.exports.flow();flow.request();
  assert.deepEqual(flow.events,[['message',null],['tone','info'],['dialog',true]]);
  assert.match(overview,/onTakePhoto=\{\(\) => openPhotoSourceSelection\(selectedOrder\)\}/);
});

test('camera and gallery choices close the dialog and keep the selected time sheet as upload target',()=>{
  for(const [handler,picker] of [['onTakePhoto','camera'],['onChoosePhoto','library']]){
    const flow=module.exports.flow();
    flow.controls.props.children[0].props[handler]();
    assert.deepEqual(flow.events,[['dialog',false],['target',24],['message',null],['tone','info'],[picker]]);
  }
  const flow=module.exports.flow();flow.controls.props.children[0].props.onClose();
  assert.deepEqual(flow.events,[['dialog',false]]);
});

test('overview mounts camera and gallery inputs using the same upload handler',()=>{
  const flow=module.exports.flow();const [,camera,gallery]=flow.controls.props.children;
  assert.equal(camera.props.capture,'environment');
  assert.equal(gallery.props.capture,undefined);
  assert.equal(camera.props.accept,'image/*');
  assert.equal(gallery.props.accept,'image/*');
  camera.props.onChange('camera-file');gallery.props.onChange('gallery-file');
  assert.deepEqual(flow.events,[['upload','camera-file'],['upload','gallery-file']]);
});

test('upload and five-photo guards prevent opening a source or file picker',()=>{
  const busy=module.exports.flow({uploading:true});busy.request();
  busy.controls.props.children[0].props.onTakePhoto();
  assert.deepEqual(busy.events,[['dialog',false]]);
  const limited=module.exports.flow({count:5});limited.request();
  assert.deepEqual(limited.events,[['message','Maximal 5 Fotos pro Stundenzettel erlaubt.'],['tone','error']]);
  assert.equal(module.exports.flow({open:false}).controls.props.children[0],null);
});
