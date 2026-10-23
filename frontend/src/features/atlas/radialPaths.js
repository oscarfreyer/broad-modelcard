// SVG path geometry for the circular atlas and chapter views.
import { GROUP_LABEL_RADIUS } from './arcLabels.js';

function polarPoint(radius, angle, centerX, centerY) {
  return {
    x: centerX + Math.sin(angle) * radius,
    y: centerY - Math.cos(angle) * radius
  };
}

export function sectorPath(region, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const outerStart = polarPoint(region.outerRadius, region.startAngle, centerX, centerY);
  const outerEnd = polarPoint(region.outerRadius, region.endAngle, centerX, centerY);
  const largeArc = region.endAngle - region.startAngle > Math.PI ? 1 : 0;
  if (region.innerRadius > 0) {
    const innerEnd = polarPoint(region.innerRadius, region.endAngle, centerX, centerY);
    const innerStart = polarPoint(region.innerRadius, region.startAngle, centerX, centerY);
    return `M ${outerStart.x} ${outerStart.y} A ${region.outerRadius} ${region.outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${region.innerRadius} ${region.innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y} Z`;
  }
  return `M ${centerX} ${centerY} L ${outerStart.x} ${outerStart.y} A ${region.outerRadius} ${region.outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} Z`;
}

/**
 * A text path along an arc around the ring's centre, clockwise, or
 * counter-clockwise when `reversed` (so text on the lower half reads left
 * to right).
 */
export function arcTextPath(radius, startAngle, endAngle, reversed, width = 1000, height = 1000) {
  const centerX = width / 2;
  const centerY = height / 2;
  const start = polarPoint(radius, reversed ? endAngle : startAngle, centerX, centerY);
  const end = polarPoint(radius, reversed ? startAngle : endAngle, centerX, centerY);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 ${reversed ? 0 : 1} ${end.x} ${end.y}`;
}

export function atlasIconPoint(region, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const angle = region.startAngle + (region.endAngle - region.startAngle) / 2;
  return polarPoint(region.outerRadius + 22, angle, centerX, centerY);
}

export function circleBandPath(region) {
  const outerTop = polarPoint(region.outerRadius, 0, region.centerX, region.centerY);
  const outerBottom = polarPoint(region.outerRadius, Math.PI, region.centerX, region.centerY);
  const innerTop = polarPoint(region.innerRadius, 0, region.centerX, region.centerY);
  const innerBottom = polarPoint(region.innerRadius, Math.PI, region.centerX, region.centerY);
  return `M ${outerTop.x} ${outerTop.y} A ${region.outerRadius} ${region.outerRadius} 0 1 1 ${outerBottom.x} ${outerBottom.y} A ${region.outerRadius} ${region.outerRadius} 0 1 1 ${outerTop.x} ${outerTop.y} L ${innerTop.x} ${innerTop.y} A ${region.innerRadius} ${region.innerRadius} 0 1 0 ${innerBottom.x} ${innerBottom.y} A ${region.innerRadius} ${region.innerRadius} 0 1 0 ${innerTop.x} ${innerTop.y} Z`;
}

export function radialLinePoints(region, angle) {
  return {
    start: polarPoint(region.innerRadius, angle, region.centerX, region.centerY),
    end: polarPoint(region.outerRadius, angle, region.centerX, region.centerY)
  };
}

export function circleLabelArcPath(group, region) {
  // The same pad as arcLabels.groupLabelSpan (GROUP_LABEL_PAD).
  const anglePadding = Math.min(0.012, Math.max(0.004, (group.endAngle - group.startAngle) * 0.08));
  const midAngle = group.startAngle + (group.endAngle - group.startAngle) / 2;
  const halfSpan = Math.min(
    Math.max(0.01, (group.endAngle - group.startAngle) / 2 - anglePadding),
    0.46
  );
  const startAngle = midAngle - halfSpan;
  const endAngle = midAngle + halfSpan;
  const shouldReverse = midAngle > Math.PI / 2 && midAngle < Math.PI * 1.5;
  const textRadius = GROUP_LABEL_RADIUS;
  const start = polarPoint(
    textRadius,
    shouldReverse ? endAngle : startAngle,
    region.centerX,
    region.centerY
  );
  const end = polarPoint(
    textRadius,
    shouldReverse ? startAngle : endAngle,
    region.centerX,
    region.centerY
  );
  return `M ${start.x} ${start.y} A ${textRadius} ${textRadius} 0 0 ${shouldReverse ? 0 : 1} ${end.x} ${end.y}`;
}
