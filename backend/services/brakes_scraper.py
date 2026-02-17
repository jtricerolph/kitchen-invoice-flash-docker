"""
Brakes (brake.co.uk) product data scraper.
Fetches ingredients list and allergen "Contains" statement from product pages.
URL pattern: https://www.brake.co.uk/p/{product_code}
"""
import re
import logging
import httpx
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class BrakesProduct:
    product_name: str = ""
    ingredients_text: str = ""  # full ingredients list (HTML tags stripped)
    contains_allergens: list[str] = field(default_factory=list)  # ["Egg", "Milk"]
    raw_contains: str = ""  # "Egg and Milk" — original text from Contains field


def _strip_html_tags(html: str) -> str:
    """Remove HTML tags, collapse whitespace."""
    text = re.sub(r"<[^>]+>", "", html)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _bold_to_uppercase(html: str) -> str:
    """Convert <strong>text</strong> to UPPERCASE, then strip remaining tags."""
    text = re.sub(
        r"<strong>(.*?)</strong>",
        lambda m: m.group(1).upper(),
        html, flags=re.DOTALL | re.IGNORECASE
    )
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _parse_contains(raw: str) -> list[str]:
    """Parse 'Egg, Milk and Gluten' into ['Egg', 'Milk', 'Gluten']."""
    if not raw:
        return []
    # "None of the 14 Food Allergens" means no allergens
    if "none" in raw.lower():
        return []
    # Split on commas first
    parts = [p.strip() for p in raw.split(",")]
    # The last part may contain " and " — split that too
    expanded = []
    for part in parts:
        if " and " in part:
            expanded.extend(p.strip() for p in part.split(" and ") if p.strip())
        else:
            if part:
                expanded.append(part)
    # Title-case each allergen for consistent matching
    return [a.strip().title() for a in expanded if a.strip()]


def parse_brakes_html(html: str) -> BrakesProduct:
    """Extract product name, ingredients, and Contains statement from Brakes product page HTML."""
    product = BrakesProduct()

    # Product name — typically in <h1> or page title
    title_match = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.DOTALL | re.IGNORECASE)
    if title_match:
        product.product_name = _strip_html_tags(title_match.group(1))

    # Ingredients — Brakes uses: <p>Ingredients: <p>...actual ingredients...</p></p>
    # or sometimes <p>Ingredients: ...text...</p>
    ing_match = re.search(
        r"<p>\s*Ingredients\s*:\s*(.*?)</p>\s*</p>",
        html, re.DOTALL | re.IGNORECASE
    )
    if not ing_match:
        # Fallback: single <p> without nested <p>
        ing_match = re.search(
            r"<p>\s*Ingredients\s*:\s*(.*?)</p>",
            html, re.DOTALL | re.IGNORECASE
        )
    if ing_match:
        product.ingredients_text = _bold_to_uppercase(ing_match.group(1))

    # Contains — Brakes uses: <p>Contains : Egg and Milk</p> (note space before colon)
    contains_match = re.search(
        r"<p>\s*Contains\s*:\s*(.*?)</p>",
        html, re.DOTALL | re.IGNORECASE
    )
    if contains_match:
        raw = _strip_html_tags(contains_match.group(1))
        product.raw_contains = raw
        product.contains_allergens = _parse_contains(raw)

    return product


async def fetch_brakes_product(product_code: str) -> BrakesProduct | None:
    """Fetch product data from brake.co.uk/p/{code}. Returns None on 404/error."""
    # Strip OCR artefacts like $ prefix
    clean_code = product_code.lstrip("$").strip()
    if not clean_code:
        return None

    url = f"https://www.brake.co.uk/p/{clean_code}"
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            response = await client.get(url, headers={
                "User-Agent": "KitchenApp/1.0 (ingredient-lookup)",
                "Accept": "text/html",
            })
        if response.status_code != 200:
            logger.info(f"Brakes lookup {clean_code}: HTTP {response.status_code}")
            return None
        return parse_brakes_html(response.text)
    except httpx.TimeoutException:
        logger.warning(f"Brakes lookup {clean_code}: timeout")
        return None
    except Exception as e:
        logger.warning(f"Brakes lookup {clean_code}: {e}")
        return None
