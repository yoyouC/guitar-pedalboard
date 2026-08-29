import type {
  AppendPublishedPresetRevisionRequest,
  PublishedPreset,
  PublishPresetRequest,
} from '../../shared/marketplace';
import type { RigProvenance } from '../state/presetCodec';

export interface RigPublicationClient {
  publishPreset(request: PublishPresetRequest): Promise<PublishedPreset>;
  appendPublishedPresetRevision(
    id: string,
    request: AppendPublishedPresetRevisionRequest,
  ): Promise<PublishedPreset>;
}

export type RigPublicationResult = {
  preset: PublishedPreset;
  kind: 'new-work' | 'remix' | 'new-revision';
};

export async function publishRigFromLocalSource(input: {
  client: RigPublicationClient;
  currentMemberId: string;
  request: PublishPresetRequest;
  provenance: RigProvenance | null;
}): Promise<RigPublicationResult> {
  const { client, currentMemberId, request, provenance } = input;
  if (provenance?.creatorId === currentMemberId) {
    const preset = await client.appendPublishedPresetRevision(provenance.presetId, {
      schemaVersion: request.schemaVersion,
      rig: request.rig,
      expectedUpdatedAt: provenance.presetUpdatedAt,
    });
    return { preset, kind: 'new-revision' };
  }

  const preset = await client.publishPreset({
    ...request,
    ...(provenance ? {
      source: {
        presetId: provenance.presetId,
        revisionId: provenance.revisionId,
      },
    } : {}),
  });
  return { preset, kind: provenance ? 'remix' : 'new-work' };
}
