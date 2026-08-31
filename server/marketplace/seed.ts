import type { PublishedPreset } from '../../shared/marketplace.js';

export interface MarketplaceSeedClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

export async function seedPublishedPreset(
  client: MarketplaceSeedClient,
  preset: PublishedPreset,
): Promise<void> {
  const revision = preset.currentRevision;
  await client.query(
    `INSERT INTO marketplace_members (id, handle, display_name, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [preset.creator.id, preset.creator.handle, preset.creator.displayName, preset.createdAt],
  );
  await client.query(
    `INSERT INTO marketplace_member_handle_claims (handle, member_id, claimed_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (handle) DO NOTHING`,
    [preset.creator.handle, preset.creator.id, preset.createdAt],
  );
  await client.query(
    `INSERT INTO marketplace_published_presets
       (id, creator_id, title, description, visibility, current_revision_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      preset.id,
      preset.creator.id,
      preset.title,
      preset.description,
      preset.visibility,
      revision.id,
      preset.createdAt,
      preset.updatedAt,
    ],
  );
  await client.query(
    `INSERT INTO marketplace_published_preset_revisions
       (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      revision.id,
      preset.id,
      revision.schemaVersion,
      JSON.stringify(revision.resourceDependencies),
      JSON.stringify(revision.derivedAttributes),
      JSON.stringify(revision.rig),
      revision.createdAt,
    ],
  );
  await client.query(
    `INSERT INTO marketplace_published_preset_tags (preset_id, tag_id)
     SELECT $1, unnest($2::text[])
     ON CONFLICT (preset_id, tag_id) DO NOTHING`,
    [preset.id, preset.tags.map((tag) => tag.id)],
  );
  await client.query(
    `INSERT INTO marketplace_published_preset_search_projection
       (preset_id, pedal_ids, amp_id, amp_model_key, cab_id, resource_kinds, projected_at)
     VALUES ($1, $2::text[], $3, $4, $5, $6::text[], $7)
     ON CONFLICT (preset_id) DO UPDATE SET
       pedal_ids = EXCLUDED.pedal_ids,
       amp_id = EXCLUDED.amp_id,
       amp_model_key = EXCLUDED.amp_model_key,
       cab_id = EXCLUDED.cab_id,
       resource_kinds = EXCLUDED.resource_kinds,
       projected_at = EXCLUDED.projected_at`,
    [
      preset.id,
      preset.derivedAttributes.pedalIds,
      preset.derivedAttributes.ampId,
      preset.derivedAttributes.ampModelKey,
      preset.derivedAttributes.cabId,
      preset.derivedAttributes.resourceKinds,
      preset.updatedAt,
    ],
  );
}
