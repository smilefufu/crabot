// Isolated CI-owned app only; never uses the Crabot product identifier.
#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  @autoreleasepool {
    NSString *identifier = NSBundle.mainBundle.bundleIdentifier;
    if (argc != 2 || ![identifier hasPrefix:@"com.crabot.test.removal-login."]) return 64;
    SMAppService *service = SMAppService.mainAppService;
    NSError *error = nil;
    BOOL ok = YES;
    if (!strcmp(argv[1], "register")) ok = [service registerAndReturnError:&error];
    else if (!strcmp(argv[1], "unregister")) ok = [service unregisterAndReturnError:&error];
    else if (strcmp(argv[1], "status")) return 64;
    NSString *status;
    switch (service.status) {
      case SMAppServiceStatusNotRegistered: status = @"not_registered"; break;
      case SMAppServiceStatusEnabled: status = @"enabled"; break;
      case SMAppServiceStatusRequiresApproval: status = @"requires_approval"; break;
      case SMAppServiceStatusNotFound: status = @"not_found"; break;
      default: status = @"unknown";
    }
    NSDictionary *result = @{ @"ok": @(ok), @"status": status,
      @"error_domain": error.domain ?: @"", @"error_code": @(error.code) };
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    if (!data || fwrite(data.bytes, 1, data.length, stdout) != data.length) return 74;
    fputc('\n', stdout);
    return 0;
  }
}
