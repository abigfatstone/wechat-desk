import {realpath,mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
const root=await realpath(process.cwd()), dest=join(root,'.opencode/plugins/wechat-visible/index.ts');
await mkdir(dirname(dest),{recursive:true});if(await realpath(dirname(dest))!==dirname(dest))throw Error('拒绝写入链接目录');
const code=`// wechat-visible workspace adapter\nimport {reader} from ${JSON.stringify(new URL('./adapter.mjs',import.meta.url).href)};\nexport default reader(${JSON.stringify(root)});\n`;
try{await writeFile(dest,code,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||!(await lstat(dest)).isFile()||await readFile(dest,'utf8')!==code)throw e;}console.log('已启用：'+root);
