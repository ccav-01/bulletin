/* Shared mock for local visual review and automated editor regression tests. */
(() => {
  const fixtures=window.__fixtures;
  const data=new Map([
    ['src/_data/bulletin.json',structuredClone(fixtures.current)],
    ['src/_data/previous/'+fixtures.archiveName,structuredClone(fixtures.archive)],
  ]);
  const revisions=new Map([...data.keys()].map(key=>[key,'test-sha-1']));
  const encode=value=>btoa(unescape(encodeURIComponent(JSON.stringify(value))));
  window.__mockGithub={writes:[],failWrites:false,data,revisions,failReads:false};
  window.fetch=async(input,options={})=>{
    const url=new URL(input,location.href);
    if(url.hostname!=='api.github.com')throw new Error('The local review harness blocks network fetches outside the mocked API.');
    const mock=window.__mockGithub;
    const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
    if(mock.failReads && (!options.method || options.method==='GET')) return response({message:'Network unavailable'},503);
    if(url.pathname==='/user')return response({login:'Local preview'});
    const target=url.pathname.split('/contents/')[1];
    if(target==='src/_data/previous'&&!options.method)return response([...data.keys()].filter(key=>key.startsWith(target+'/')).map(key=>({name:key.split('/').at(-1),path:key,sha:revisions.get(key)})));
    if(target){
      if(options.method==='PUT'||options.method==='DELETE'){
        if(mock.failWrites)return response({message:'Simulated publish failure'},503);
        const body=JSON.parse(options.body);
        if(body.sha && body.sha!==revisions.get(target))return response({message:'SHA conflict'},409);
        mock.writes.push({target,method:options.method,body});
        if(options.method==='DELETE'){data.delete(target);return response({});}
        const value=JSON.parse(decodeURIComponent(escape(atob(body.content))));data.set(target,value);
        const sha='test-sha-'+(mock.writes.length+1);revisions.set(target,sha);
        return response({content:{sha},commit:{sha:'test-commit'}});
      }
      return data.has(target)?response({content:encode(data.get(target)),sha:revisions.get(target)}):response({message:'Not found'},404);
    }
    if(url.pathname.includes('/actions/runs'))return response({workflow_runs:[
      {path:'.github/workflows/deploy.yml',status:'completed',conclusion:'success'},
      {path:'.github/workflows/sync-email.yml',status:'completed',conclusion:'success'},
    ]});
    return response({message:'Unhandled mocked request'},404);
  };
  // Use an obviously fictitious credential only in this isolated local harness.
  sessionStorage.setItem('bulletin_admin_token','local-review-no-access');
  window.confirm=()=>true;
})();
