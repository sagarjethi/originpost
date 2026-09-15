-- Align durable creative snapshots with the logo, disclosure and news layout
-- accepted by CreativeSpec. Preserve existing field and scope constraints.
alter table creative_revisions
  drop constraint creative_revisions_spec_keys_check,
  drop constraint creative_revisions_spec_values_check,
  add constraint creative_revisions_spec_keys_check check (
    jsonb_typeof(spec) = 'object'
    and spec ?& array['format','sourceMediaId','sourceMediaSha256','headline','layout','font','textAlign','focalPoint','zoom','palette']
    and (spec - array['format','sourceMediaId','sourceMediaSha256','contentItemId','kicker','headline','subtitle','footer','layout','font','textAlign','focalPoint','zoom','palette','logo','disclosure']) = '{}'::jsonb
  ),
  add constraint creative_revisions_spec_values_check check (
    spec->>'format' in ('square','portrait','story')
    and spec->>'sourceMediaId' = source_media_id
    and spec->>'sourceMediaSha256' = source_media_sha256
    and coalesce(spec->>'contentItemId', '') = coalesce(content_item_id, '')
    and jsonb_typeof(spec->'headline') = 'string' and char_length(spec->>'headline') between 1 and 180
    and (not spec ? 'kicker' or (jsonb_typeof(spec->'kicker') = 'string' and char_length(spec->>'kicker') <= 80))
    and (not spec ? 'subtitle' or (jsonb_typeof(spec->'subtitle') = 'string' and char_length(spec->>'subtitle') <= 280))
    and (not spec ? 'footer' or (jsonb_typeof(spec->'footer') = 'string' and char_length(spec->>'footer') <= 120))
    and spec->>'layout' in ('editorial','headline','headline-top','quote')
    and spec->>'font' in ('manrope','newsreader')
    and spec->>'textAlign' in ('left','center')
    and jsonb_typeof(spec->'focalPoint') = 'object'
    and ((spec->'focalPoint') - array['x','y']) = '{}'::jsonb
    and spec->'focalPoint' ?& array['x','y']
    and jsonb_typeof(spec->'focalPoint'->'x') = 'number'
    and jsonb_typeof(spec->'focalPoint'->'y') = 'number'
    and (spec->'focalPoint'->>'x')::numeric between 0 and 100
    and (spec->'focalPoint'->>'y')::numeric between 0 and 100
    and jsonb_typeof(spec->'zoom') = 'number'
    and (spec->>'zoom')::numeric between 1 and 2
    and jsonb_typeof(spec->'palette') = 'array'
    and jsonb_array_length(spec->'palette') = 5
    and spec->'palette'->>0 ~ '^#[A-Fa-f0-9]{6}$'
    and spec->'palette'->>1 ~ '^#[A-Fa-f0-9]{6}$'
    and spec->'palette'->>2 ~ '^#[A-Fa-f0-9]{6}$'
    and spec->'palette'->>3 ~ '^#[A-Fa-f0-9]{6}$'
    and spec->'palette'->>4 ~ '^#[A-Fa-f0-9]{6}$'
  ),
  add constraint creative_revisions_disclosure_check check (
    not spec ? 'disclosure' or
    (jsonb_typeof(spec->'disclosure') = 'string' and char_length(spec->>'disclosure') <= 60)
  ),
  add constraint creative_revisions_logo_check check (
    not spec ? 'logo' or (
      jsonb_typeof(spec->'logo') = 'object'
      and (spec->'logo') ?& array['mediaId','sha256','position','widthPercent','marginPercent','background','crop']
      and ((spec->'logo') - array['mediaId','sha256','position','widthPercent','marginPercent','background','crop']) = '{}'::jsonb
      and jsonb_typeof(spec->'logo'->'mediaId') = 'string'
      and char_length(spec->'logo'->>'mediaId') between 1 and 200
      and jsonb_typeof(spec->'logo'->'sha256') = 'string'
      and spec->'logo'->>'sha256' ~ '^[a-f0-9]{64}$'
      and spec->'logo'->>'position' in ('top-left','top-right')
      and spec->'logo'->>'crop' in ('full','top-left','top-right','bottom-left','bottom-right')
      and jsonb_typeof(spec->'logo'->'background') = 'string'
      and spec->'logo'->>'background' ~ '^#[A-Fa-f0-9]{6}$'
      and jsonb_typeof(spec->'logo'->'widthPercent') = 'number'
      and (spec->'logo'->>'widthPercent')::numeric between 8 and 25
      and jsonb_typeof(spec->'logo'->'marginPercent') = 'number'
      and (spec->'logo'->>'marginPercent')::numeric between 2 and 6
    )
  );
