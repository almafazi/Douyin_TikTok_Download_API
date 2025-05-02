package utils

// GetNestedValue gets a nested value from a map using a key path
func GetNestedValue(data map[string]interface{}, keys []string, defaultVal interface{}) interface{} {
	result := data

	for _, key := range keys {
		value, ok := result[key]
		if !ok {
			return defaultVal
		}

		if nestedMap, isMap := value.(map[string]interface{}); isMap {
			result = nestedMap
		} else {
			return value
		}
	}

	return result
}

// GetFirstFromNestedList gets the first string item from a nested list
func GetFirstFromNestedList(data map[string]interface{}, keys []string, defaultVal string) string {
	nested := GetNestedValue(data, keys, []interface{}{})
	if list, ok := nested.([]interface{}); ok && len(list) > 0 {
		if str, ok := list[0].(string); ok {
			return str
		}
	}
	return defaultVal
}

// GetIntStat extracts an integer statistic from a map with type checking
func GetIntStat(statistics map[string]interface{}, key string) int {
	val, ok := statistics[key].(float64)
	if ok {
		return int(val)
	}
	return 0
}