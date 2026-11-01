import type {ChildProcess} from 'node:child_process';
export function detectWslDocker():string|null;
export function isManagedLocalDatabase(connectionString:string|undefined):boolean;
export function startLocalDatabaseKeeper(options?:{onUnexpectedExit?:(error:Error)=>void}):Promise<null|{child:ChildProcess;ready:Promise<unknown>;closed:Promise<unknown>;stop:()=>Promise<unknown>;distro:string;linuxPid:number;token:string}>;
