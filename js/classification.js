export const CLASSIFICATION_FIELDS = Object.freeze(["koushu", "shubetsu", "saibetsu", "sokuten", "tekiyo"]);

export function effectiveClassification(photo) {
  const original = photo?.classification && typeof photo.classification === "object" ? photo.classification : {};
  const override = photo?.classificationOverride && typeof photo.classificationOverride === "object" ? photo.classificationOverride : {};
  return Object.fromEntries(CLASSIFICATION_FIELDS.map(field => [
    field,
    Object.prototype.hasOwnProperty.call(override, field) ? String(override[field] ?? "") : String(original[field] ?? "")
  ]));
}

export function hasClassificationOverride(photo) {
  const override = photo?.classificationOverride;
  return Boolean(override && CLASSIFICATION_FIELDS.some(field => Object.prototype.hasOwnProperty.call(override, field)));
}
