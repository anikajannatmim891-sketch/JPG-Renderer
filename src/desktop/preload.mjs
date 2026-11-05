import {contextBridge,ipcRenderer,webUtils} from 'electron';
const channels=['metadata-validate','metadata-settings','gpu-report','state','open','drop','recent','paste','destination','enqueue','cancel','retry','preview','reveal','folder','vector'];
contextBridge.exposeInMainWorld('studio',{
  call:async(channel,...args)=>{if(!channels.includes(channel))throw new Error('Unknown command');const response=await ipcRenderer.invoke(channel,...args);if(!response.ok)throw new Error(response.error);return response.value;},
  filePath:file=>webUtils.getPathForFile(file),
  onJobs:fn=>{const handler=(_e,jobs)=>fn(jobs);ipcRenderer.on('jobs',handler);return()=>ipcRenderer.removeListener('jobs',handler);}
});
