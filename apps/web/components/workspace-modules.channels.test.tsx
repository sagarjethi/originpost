import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChannelConnectionButton, instagramConnectionRoute } from './workspace/channel-connection';

const onConnect=()=>undefined;
describe('publishing account connection guidance',()=>{
  it('uses Facebook Login when direct Instagram is disabled, and reports unavailable only if both are off',()=>{
    expect(instagramConnectionRoute({instagram:{configured:false},instagramFacebook:{configured:true}})).toBe('instagramFacebook');
    expect(instagramConnectionRoute({instagram:{configured:true},instagramFacebook:{configured:true}})).toBe('instagram');
    expect(instagramConnectionRoute({instagram:{configured:false},instagramFacebook:{configured:false}})).toBeNull();
    expect(instagramConnectionRoute(null)).toBeNull();
  });
  it('offers setup for missing configuration and an enabled connect action for a configured owner',()=>{
    const unavailable=renderToStaticMarkup(<ChannelConnectionButton ready={false} loading={false} canManage label="Connect Instagram" onConnect={onConnect} />);
    expect(unavailable).toContain('href="/setup"');expect(unavailable).toContain('Set up connection');
    const available=renderToStaticMarkup(<ChannelConnectionButton ready loading={false} canManage label="Connect Instagram" onConnect={onConnect} />);
    expect(available).toContain('Connect Instagram');expect(available).not.toContain('disabled');expect(available).not.toContain('href="/setup"');
  });
  it('keeps actions disabled while checking and for members who cannot manage accounts',()=>{
    const loading=renderToStaticMarkup(<ChannelConnectionButton ready loading canManage label="Connect Instagram" onConnect={onConnect} />);
    expect(loading).toContain('disabled');
    const creator=renderToStaticMarkup(<ChannelConnectionButton ready={false} loading={false} canManage={false} label="Connect Instagram" onConnect={onConnect} />);
    expect(creator).toContain('disabled');expect(creator).toContain('Owner access required');expect(creator).not.toContain('href="/setup"');
  });
});
