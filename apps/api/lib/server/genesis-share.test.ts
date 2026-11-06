import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
const mock=vi.hoisted(()=>({shareProfile:vi.fn()}));
vi.mock('./genesis-service',()=>({genesis:mock}));
import { genesisShareResponse } from './genesis-share';
afterEach(()=>vi.unstubAllEnvs());
function setup(){vi.stubEnv('NEXT_PUBLIC_APP_URL','https://oneshot-web.pages.dev');vi.stubEnv('ONESHOT_API_URL','https://api.oneshot.example.com');}
describe('Genesis public invitation rendering',()=>{
  it('changes the crawler image URL when public status or sharing consent changes',async()=>{
    setup();const request=new NextRequest('https://api.oneshot.example.com/api/oneshot/genesis/share/abcdefghijklmnop');
    const imageUrl=async()=>{const html=await(await genesisShareResponse(request,'abcdefghijklmnop',false)).text();return /property="og:image" content="([^"]+)"/.exec(html)![1];};
    mock.shareProfile.mockResolvedValue({profile:{id:'123',username:'person',name:'Person',avatarUrl:null},status:'Applied for Genesis'});const applied=await imageUrl();
    mock.shareProfile.mockResolvedValue({profile:{id:'123',username:'person',name:'Person',avatarUrl:null},status:'Selected for Genesis'});const selected=await imageUrl();
    mock.shareProfile.mockResolvedValue(null);const generic=await imageUrl();
    expect(applied).toMatch(/\/image\?v=[a-f0-9]{16}$/);expect(selected).not.toBe(applied);expect(generic).not.toBe(selected);expect(await imageUrl()).toBe(generic);
  });
  it('returns crawler metadata before JavaScript and only opted-in public fields',async()=>{setup();mock.shareProfile.mockResolvedValue({profile:{id:'123',username:'person',name:'Private name',avatarUrl:null},status:'Applied for Genesis'});const response=await genesisShareResponse(new NextRequest('https://api.oneshot.example.com/api/oneshot/genesis/share/abcdefghijklmnop'),'abcdefghijklmnop',false);const html=await response.text();expect(html).toContain('name="twitter:card" content="summary_large_image"');expect(html).toContain('https://api.oneshot.example.com/api/oneshot/genesis/share/abcdefghijklmnop/image');expect(html).toContain('person · Applied for Genesis');expect(html).not.toContain('Private name');expect(html).not.toContain('<script');expect(response.headers.get('cache-control')).toBe('no-store');});
  it('renders a real 1200 by 630 PNG and uses a generic card after consent is withdrawn',async()=>{setup();mock.shareProfile.mockResolvedValue(null);const request=new NextRequest('https://api.oneshot.example/api/oneshot/genesis/share/abcdefghijklmnop/image');const response=await genesisShareResponse(request,'abcdefghijklmnop',true);expect(response.headers.get('content-type')).toBe('image/png');const metadata=await sharp(Buffer.from(await response.arrayBuffer())).metadata();expect(metadata).toMatchObject({width:1200,height:630,format:'png'});const html=await(await genesisShareResponse(request,'abcdefghijklmnop',false)).text();expect(html).toContain('oneshot Genesis · The first edition');expect(html).not.toContain('person ·');});
});
