// Shared interfaces and utilities for ingredient creation/editing modals

export interface IngredientCategory {
  id: number
  name: string
  sort_order: number
  ingredient_count: number
}

export interface SimilarIngredient {
  id: number
  name: string
  similarity: number
}

export interface LineItemResult {
  product_code: string | null
  description: string | null
  supplier_id: number | null
  supplier_name: string | null
  unit: string | null
  most_recent_price: number | null
  total_quantity: number | null
  occurrence_count: number
  most_recent_invoice_id: number
  most_recent_line_number: number | null
  most_recent_pack_quantity: number | null
  most_recent_unit_size: number | null
  most_recent_unit_size_type: string | null
  ingredient_id: number | null
  ingredient_name: string | null
}

export interface EditingIngredient {
  id: number
  name: string
  category_id: number | null
  standard_unit: string
  yield_percent: number
  manual_price: number | null
  notes: string | null
  is_prepackaged: boolean
  product_ingredients: string | null
  has_label_image: boolean
}

export interface IngredientModalResult {
  id: number
  name: string
  standard_unit: string
}

export const LI_CONVERSIONS: Record<string, Record<string, number>> = {
  g: { g: 1, kg: 0.001 }, kg: { g: 1000, kg: 1 }, oz: { g: 28.3495, kg: 0.0283495 },
  ml: { ml: 1, ltr: 0.001 }, cl: { ml: 10, ltr: 0.01 }, ltr: { ml: 1000, ltr: 1 },
  each: { each: 1 },
}

export function calcConversionDisplay(
  packQty: number, unitSize: number | null, unitSizeType: string,
  standardUnit: string, unitPrice: number | null
): string {
  if (!unitSize || !unitSizeType) return ''
  const conv = LI_CONVERSIONS[unitSizeType]?.[standardUnit]
  if (!conv) return unitSizeType !== standardUnit ? `Cannot convert ${unitSizeType} \u2192 ${standardUnit}` : ''
  const totalStd = packQty * unitSize * conv
  const pricePerStd = unitPrice ? (unitPrice / totalStd) : null
  const packNote = packQty > 1 ? `${packQty} \u00d7 ${unitSize}${unitSizeType} = ` : ''
  let display = `${packNote}${totalStd.toFixed(totalStd % 1 ? 2 : 0)} ${standardUnit}`
  if (pricePerStd) {
    display += ` \u2192 \u00a3${pricePerStd.toFixed(4)} per ${standardUnit}`
    if (standardUnit === 'g') display += ` (\u00a3${(pricePerStd * 1000).toFixed(2)}/kg)`
    else if (standardUnit === 'ml') display += ` (\u00a3${(pricePerStd * 1000).toFixed(2)}/ltr)`
  }
  return display
}

export function parsePackFromDescription(desc: string): { qty: number; size: string; type: string } | null {
  const packMatch = desc.match(/(\d+)\s*[x\u00d7]\s*(\d+(?:\.\d+)?)\s*(g|kg|ml|ltr|l|oz|cl|gm|gms)\b/i)
  if (packMatch) {
    let ut = packMatch[3].toLowerCase()
    if (ut === 'l') ut = 'ltr'
    if (ut === 'gm' || ut === 'gms') ut = 'g'
    return { qty: parseInt(packMatch[1]), size: packMatch[2], type: ut }
  }
  const standaloneMatch = desc.match(/(\d+(?:\.\d+)?)\s*(g|kg|ml|ltr|l|oz|cl|gm|gms|gram|grams|kilo|kilos|kilogram|litre|litres|liter)\b/i)
  if (standaloneMatch) {
    let ut = standaloneMatch[2].toLowerCase()
    if (ut === 'l' || ut === 'litre' || ut === 'litres' || ut === 'liter') ut = 'ltr'
    if (ut === 'gm' || ut === 'gms' || ut === 'gram' || ut === 'grams') ut = 'g'
    if (ut === 'kilo' || ut === 'kilos' || ut === 'kilogram') ut = 'kg'
    return { qty: 1, size: standaloneMatch[1], type: ut }
  }
  return null
}
