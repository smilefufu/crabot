"""临时冒烟文件：验证 branch protection 下的自动合并，验证后删除。"""


def clamp(value: float, low: float, high: float) -> float:
    if low > high:
        raise ValueError("low 不能大于 high")
    return max(low, min(high, value))
