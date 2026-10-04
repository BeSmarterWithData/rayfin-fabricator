'use client';

import DefaultSearchDialog, { type DefaultSearchDialogProps } from 'fumadocs-ui/components/dialog/search-default';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const searchApi = `${basePath}/api/search`;

export function FabricatorSearchDialog(props: DefaultSearchDialogProps) {
  return <DefaultSearchDialog {...props} api={searchApi} />;
}
