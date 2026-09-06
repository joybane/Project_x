package main

// buildUpdateSteps wires up every table project_x knows how to refresh.
// Each Run function fetches whatever is missing since the table's latest
// date and merges it in via mergeRowsIntoTable.
func buildUpdateSteps() []updateStep {
	return []updateStep{
		{ID: "nse_price_volume", Label: "NSE Price/Volume", Run: fetchNSEPriceVolume},
		{ID: "nse_delivery", Label: "NSE Delivery", Run: fetchNSEDelivery},
		{ID: "nse_bulk_deals", Label: "NSE Bulk Deals", Run: fetchNSEBulkDeals},
		{ID: "nse_block_deals", Label: "NSE Block Deals", Run: fetchNSEBlockDeals},
		{ID: "nse_short_selling", Label: "NSE Short Selling", Run: fetchNSEShortSelling},
		{ID: "bse_price_volume", Label: "BSE Price/Volume", Run: fetchBSEPriceVolume},
		{ID: "bse_delivery", Label: "BSE Delivery", Run: fetchBSEDelivery},
		{ID: "bse_block_deals", Label: "BSE Block Deals", Run: fetchBSEBlockDeals},
		{ID: "bse_index_sensex", Label: "BSE Sensex Index", Run: fetchBSEIndexSensex},
		{ID: "bse_reference", Label: "BSE Reference Catalog", Run: fetchBSEReference},
	}
}
