/**
 * Implemented workflow modules. A business can only enable workflows listed
 * here; anything else in business.json is a configuration error.
 */
import * as restaurantOrdering from './restaurant-ordering.js';

export const WORKFLOWS = {
    [restaurantOrdering.id]: restaurantOrdering,
};
