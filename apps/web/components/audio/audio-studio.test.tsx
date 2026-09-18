import { renderToStaticMarkup } from 'react-dom/server';
import { describe,it,expect } from 'vitest';
import { AudioStudio } from './audio-studio';
const base={mode:'sessions' as const,user:{id:'user',email:'private@example.test',displayName:'Private name'},memberships:[]};
describe('audio workspace access presentation',()=>{
 it('offers configuration to the exact workspace owner without exposing identity',()=>{
   const auth={...base,memberships:[{workspaceId:'w',workspaceName:'W',workspaceSlug:'w',userId:'user',role:'owner' as const}]};
   const html=renderToStaticMarkup(<AudioStudio auth={auth} workspaceId="w" brandId="b"/>);
   expect(html).toContain('Connect provider');expect(html).toContain('Keys stay encrypted');expect(html).not.toContain('private@example.test');
 });
 it('does not inherit owner configuration privileges from another workspace',()=>{
   const auth={...base,memberships:[{workspaceId:'other',workspaceName:'Other',workspaceSlug:'other',userId:'user',role:'owner' as const},{workspaceId:'w',workspaceName:'W',workspaceSlug:'w',userId:'user',role:'viewer' as const}]};
   const html=renderToStaticMarkup(<AudioStudio auth={auth} workspaceId="w" brandId="b"/>);
   expect(html).not.toContain('Connect provider');
 });
 it('gives shared creators a narration interface without connection administration',()=>{
   const auth={...base,memberships:[{workspaceId:'w',workspaceName:'W',workspaceSlug:'w',userId:'user',role:'creator' as const}]};
   const html=renderToStaticMarkup(<AudioStudio auth={auth} workspaceId="w" brandId="b"/>);
   expect(html).toContain('workspace-approved voices');
   expect(html).not.toContain('Connect provider');
   expect(html).not.toContain('API key');
 });
});
