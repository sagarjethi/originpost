import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {GenerationActions} from './generation-actions';
it('routes missing image setup separately from text and preserves image-only entry',()=>{
 const html=renderToStaticMarkup(<GenerationActions text={false} image={false} review={false} loading={false} canConfigure />);
 expect(html).toContain('/setup?provider=images');expect(html).toContain('/agent-plugins');expect(html).toContain('/creative-studio');
});
it('reports failed checks instead of indefinitely checking or advertising stale readiness',()=>{
 const html=renderToStaticMarkup(<GenerationActions research text image review loading={false} unavailable canConfigure />);
 expect(html).toContain('Status unavailable');expect(html).not.toContain('Configured');expect(html).not.toContain('Checking…');
});
it('does not claim unknown providers are ready or expose setup actions to creators',()=>{
 const html=renderToStaticMarkup(<GenerationActions loading canConfigure={false}/>);
 expect(html).toContain('Checking');expect(html).not.toContain('Configured');expect(html).not.toContain('/setup');
 const missing=renderToStaticMarkup(<GenerationActions text={false} image={false} review={false} loading={false} canConfigure={false}/>);
 expect(missing).toContain('workspace owner');expect(missing).not.toContain('/agent-plugins');
});
