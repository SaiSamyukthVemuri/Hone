// Display-only rectangles, in the calendar's existing vertical coordinate
// system. This function grants no booking capacity and never edits a row.
export type AppointmentRectangle = { id: string; top: number; height: number };
export type AppointmentLane = { column: number; columns: number };

export function appointmentLanes(
  rectangles: ReadonlyArray<AppointmentRectangle>,
): Map<string, AppointmentLane> {
  const ordered = [...rectangles].sort((a, b) => a.top - b.top || a.id.localeCompare(b.id));
  const result = new Map<string, AppointmentLane>();
  let group: AppointmentRectangle[] = [];
  let bottom = -Infinity;
  const flush = () => {
    const ends: number[] = [];
    const assignments: Array<{ id: string; column: number }> = [];
    for (const rectangle of group) {
      let column = ends.findIndex((end) => end <= rectangle.top);
      if (column < 0) column = ends.length;
      ends[column] = rectangle.top + rectangle.height;
      assignments.push({ id: rectangle.id, column });
    }
    for (const { id, column } of assignments) {
      result.set(id, { column, columns: ends.length });
    }
    group = [];
  };
  for (const rectangle of ordered) {
    if (rectangle.top >= bottom) flush();
    group.push(rectangle);
    bottom = Math.max(bottom, rectangle.top + rectangle.height);
  }
  flush();
  return result;
}


export type AppointmentCollisionGroup = { ids: string[]; top: number; height: number };

// Coarse targets use their actual 44px rendered floor. Clinically adjacent
// short appointments can therefore belong to one display group; this is not
// a booking conflict classification. Keep the entire occupied vertical span.
export function appointmentCollisionGroups(
  rectangles: ReadonlyArray<AppointmentRectangle>,
): AppointmentCollisionGroup[] {
  const ordered = [...rectangles].sort((a, b) => a.top - b.top || a.id.localeCompare(b.id));
  const groups: AppointmentCollisionGroup[] = [];
  for (const rectangle of ordered) {
    const height = Math.max(44, rectangle.height);
    const group = groups[groups.length - 1];
    if (!group || rectangle.top >= group.top + group.height) {
      groups.push({ ids: [rectangle.id], top: rectangle.top, height });
    } else {
      group.ids.push(rectangle.id);
      group.height = Math.max(group.height, rectangle.top + height - group.top);
    }
  }
  return groups;
}
