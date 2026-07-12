"""临时冒烟测试文件：验证自动 review 流程，验证后删除。"""


def parse_port(value):
    port = int(value)
    if not 0 < port < 65536:
        raise ValueError(f"非法端口: {value}")
    return port


def is_empty(s):
    return s == ""
