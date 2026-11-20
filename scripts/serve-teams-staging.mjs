// Serve only the practice manager and its static assets, plus a local organizer login.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import path from 'node:path';

export async function serveTeamsPreview({api, publicKey, lan}) {
  const adapter=Object.values(networkInterfaces()).flat().find(address=>
    address?.family==='IPv4'&&!address.internal&&
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address));
  if(lan&&!adapter)throw Error('No private LAN address found; connect the computer and phone to the same trusted Wi-Fi.');
  const host=lan?adapter.address:'127.0.0.1';
  api.hostname=host;
  const config={url:api.origin,publishableKey:publicKey};
  const root=path.resolve(import.meta.dirname,'../website');
  const allowed=new Map([
    ['/styles.css','styles.css'],['/favicon.svg','favicon.svg'],
    ['/favicon-192.png','favicon-192.png'],
    ...['index.html','teams.mjs','teams.css','scheduling.mjs','balancing.mjs','rotation-options.mjs','profile-options.mjs']
      .map(name=>['/teams/'+name,'teams/'+name])
  ]);
  const types={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.svg':'image/svg+xml','.png':'image/png'};
  const login=`<!doctype html><meta name="viewport" content="width=device-width"><title>Local organizer sign-in</title>
  <h1>Local test organizer</h1><p>The practice password appears in the host terminal.</p>
  <form><label>Email <input id="email" value="organizer@phone-review.example.invalid" type="email" required autocomplete="username"></label><br>
  <label>Password <input id="password" type="password" required autocomplete="current-password"></label><br><button>Sign in</button></form><p id="message"></p>
  <script src="/staging-config.js"></script><script type="module">
  import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.119.0';
  const cfg=window.TEAMS_MANAGER_STAGING_CONFIG,client=createClient(cfg.url,cfg.publishableKey);
  document.querySelector('form').onsubmit=async event=>{event.preventDefault();
  const {error}=await client.auth.signInWithPassword({email:document.querySelector('#email').value,password:document.querySelector('#password').value});
  if(error)document.querySelector('#message').textContent=error.message;else location.href='/teams/';};
  </script>`;
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    try{
      let pathname=new URL(req.url,'http://localhost').pathname;
      if(pathname==='/'){res.writeHead(302,{Location:'/teams/'}).end();return;}
      if(pathname==='/staging-config.js'){
        res.writeHead(200,{'Content-Type':'text/javascript'}).end('window.TEAMS_MANAGER_STAGING_CONFIG='+JSON.stringify(config)+';');return;
      }
      if(pathname==='/staging-login'){
        res.writeHead(200,{'Content-Type':'text/html'}).end(login);return;
      }
      if(pathname==='/teams/')pathname='/teams/index.html';
      const file=allowed.get(pathname);
      if(!file){res.writeHead(404).end('Only the local Teams Manager preview is served here.');return;}
      let content=await readFile(path.join(root,file));
      if(file==='teams/index.html')content=content.toString().replace('<head>',
        '<head><script src="/staging-config.js"></script>').replaceAll('../?dashboard=1','/staging-login');
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'}).end(content);
    }catch{res.writeHead(500).end('Local preview unavailable.');}
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8080, host, resolve);
  });
  return {server, url:'http://'+host+':8080/teams/'};
}
