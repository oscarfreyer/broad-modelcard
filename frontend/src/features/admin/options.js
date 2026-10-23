// The label of a value among a form's { value, label } choices, or the value
// itself when it is not one of them (a code from a file or a newer backend).

export const optionLabel = (options, value) => options.find((option) => option.value === value)?.label ?? value ?? '';
