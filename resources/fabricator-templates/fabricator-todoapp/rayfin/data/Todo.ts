import {
  entity,
  authenticated,
  text,
  boolean,
  date,
  uuid,
} from '@microsoft/rayfin-core';

@entity()
@authenticated('*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Todo {
  @uuid() id!: string;
  @text({ min: 1, max: 100 }) title!: string;
  @boolean() isCompleted!: boolean;
  @date() createdAt!: Date;
  @text({ max: 128 }) user_id!: string;
}
