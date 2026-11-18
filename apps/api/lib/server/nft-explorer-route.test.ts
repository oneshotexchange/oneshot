import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from './http';
import * as indexed from './indexed-nfts';
import { oneshotApi } from './oneshot-api';
const collection=`0x${'1'.repeat(40)}`;
afterEach(()=>vi.restoreAllMocks());
describe('bounded public collection explorer dispatch',()=>{
  it.each(['explore','%65xplore','e%78plore'])('applies the explorer budget before canonical reads for %s',async child=>{
    const budget=vi.spyOn(http,'rateLimit').mockImplementation(()=>{}),read=vi.spyOn(indexed,'indexedNftRead').mockResolvedValue(Response.json({fixture:true}));
    const response=await oneshotApi(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}/${child}`),{});
    expect(response.status).toBe(200);expect(budget.mock.calls).toContainEqual(['oneshot:indexed:explore',20]);expect(read).toHaveBeenCalledTimes(1);
    expect(budget.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  });
  it('leaves ordinary read budgets unchanged and stops expensive work after the budget rejects',async()=>{
    const budget=vi.spyOn(http,'rateLimit').mockImplementation(()=>{}),read=vi.spyOn(indexed,'indexedNftRead').mockResolvedValue(Response.json({fixture:true}));
    await oneshotApi(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}/items`),{});expect(budget.mock.calls).toEqual([['oneshot:indexed:public',240]]);
    budget.mockImplementation(()=>{throw new http.ApiError(429,'RATE_LIMITED','Please wait before trying again.');});read.mockClear();
    expect((await oneshotApi(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}/explore`),{})).status).toBe(429);expect(read).not.toHaveBeenCalled();
  });
});
